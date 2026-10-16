use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicBool, Ordering};

const LABEL: &str = "pet-chat";
static PINNED: AtomicBool = AtomicBool::new(false);

fn notify_visibility(app: &AppHandle, visible: bool) {
    for label in [LABEL, "pet"] {
        if let Some(window)=app.get_webview_window(label) { let _=window.emit("pet-chat-visible",visible); }
    }
}

#[derive(serde::Serialize)]
pub struct ChatState { visible: bool, pinned: bool }

#[tauri::command]
pub fn get_pet_chat_state(app: AppHandle) -> ChatState {
    ChatState { visible: app.get_webview_window(LABEL).is_some_and(|window| window.is_visible().unwrap_or(false)), pinned: PINNED.load(Ordering::Relaxed) }
}

#[tauri::command]
pub fn set_pet_chat_pinned(app: AppHandle, pinned: bool) -> Result<bool,String> {
    if let Some(chat)=app.get_webview_window(LABEL) { chat.set_always_on_top(pinned).map_err(|e|e.to_string())?; }
    PINNED.store(pinned,Ordering::Relaxed);
    Ok(pinned)
}

// Clicking the pet transfers focus before its pointer-up toggle. Let that toggle
// handle closing, otherwise a focus-loss hide would immediately reopen the chat.
fn pressing_pet(app: &AppHandle) -> bool {
    if !super::mouse_buttons().0 { return false; }
    let Some(pet)=app.get_webview_window("pet") else { return false; };
    let (Ok(cursor),Ok(origin),Ok(scale))=(pet.cursor_position(),pet.inner_position(),pet.scale_factor()) else { return false; };
    let bounds=app.state::<super::HitRegions>().0.lock().ok().and_then(|regions|regions.first().cloned());
    bounds.is_some_and(|r|cursor.x >= origin.x as f64+r.x*scale && cursor.x <= origin.x as f64+(r.x+r.w)*scale && cursor.y >= origin.y as f64+r.y*scale && cursor.y <= origin.y as f64+(r.y+r.h)*scale)
}

fn hide_on_blur(pinned: bool, pet_press: bool) -> bool { !pinned && !pet_press }

#[tauri::command]
pub async fn toggle_pet_chat(app: AppHandle) -> Result<(),String> {
    let visible=get_pet_chat_state(app.clone()).visible;
    set_pet_chat_visible(app,!visible).await
}

fn position(anchor: (i32,i32,i32,i32), area: (i32,i32,i32,i32), size: (i32,i32)) -> (i32,i32) {
    let (x,y,w,h)=anchor; let (left,top,width,height)=area; let (cw,ch)=size;
    let right=x+w+12;
    let desired=if right+cw <= left+width-8 { right } else { x-cw-12 };
    (desired.clamp(left+8,(left+width-cw-8).max(left+8)), (y+h-ch).clamp(top+8,(top+height-ch-8).max(top+8)))
}

#[tauri::command]
pub async fn set_pet_chat_visible(app: AppHandle, visible: bool) -> Result<(),String> {
    if !visible {
        if let Some(chat)=app.get_webview_window(LABEL) { chat.hide().map_err(|e|e.to_string())?; }
        notify_visibility(&app,false);
        return Ok(());
    }
    let chat=if let Some(chat)=app.get_webview_window(LABEL) { chat } else {
        let dev_url=app.config().build.dev_url.clone();
        let chat=WebviewWindowBuilder::new(&app,LABEL,WebviewUrl::App("pet-chat.html".into()))
            .title("tebb 对话").inner_size(340.,420.).min_inner_size(300.,340.)
            .decorations(false).always_on_top(PINNED.load(Ordering::Relaxed)).skip_taskbar(true).visible(false)
            // This local credential-bearing webview must never navigate into remote content.
            .on_navigation(move|url|url.path()=="/pet-chat.html" && (
                (url.scheme()=="tauri" && url.host_str()==Some("localhost")) ||
                (url.scheme()=="http" && url.host_str()==Some("tauri.localhost") && url.port_or_known_default()==Some(80)) ||
                dev_url.as_ref().is_some_and(|dev|dev.scheme()==url.scheme()&&dev.host_str()==url.host_str()&&dev.port_or_known_default()==url.port_or_known_default())
            ))
            .build().map_err(|e|e.to_string())?;
        let close=chat.clone();
        chat.on_window_event(move|event| match event {
            tauri::WindowEvent::CloseRequested{api,..} => { api.prevent_close();let _=close.hide();notify_visibility(close.app_handle(),false); },
            tauri::WindowEvent::Focused(false) if hide_on_blur(PINNED.load(Ordering::Relaxed),pressing_pet(close.app_handle())) => { let _=close.hide();notify_visibility(close.app_handle(),false); },
            _ => (),
        });
        chat
    };
    if let Some(pet)=app.get_webview_window("pet") {
        if let (Ok(origin),Ok(scale),Ok(Some(monitor)))=(pet.inner_position(),pet.scale_factor(),pet.current_monitor()) {
            let size=chat.outer_size().map_err(|e|e.to_string())?;
            let bounds=app.state::<super::HitRegions>().0.lock().ok().and_then(|list|list.first().cloned());
            let anchor=bounds.map(|r|(origin.x+(r.x*scale) as i32,origin.y+(r.y*scale) as i32,(r.w*scale) as i32,(r.h*scale) as i32)).unwrap_or((origin.x,origin.y,48,48));
            let work=monitor.work_area();
            let area=(work.position.x,work.position.y,work.size.width as i32,work.size.height as i32);
            let (x,y)=position(anchor,area,(size.width as i32,size.height as i32));
            chat.set_position(PhysicalPosition::new(x,y)).map_err(|e|e.to_string())?;
        }
    }
    chat.show().map_err(|e|e.to_string())?;
    notify_visibility(&app,true);
    chat.set_focus().map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{position,hide_on_blur};
    #[test] fn unpinned_chat_hides_on_outside_focus_but_pet_click_remains_a_toggle() {
        assert!(hide_on_blur(false,false));
        assert!(!hide_on_blur(false,true));
        assert!(!hide_on_blur(true,false));
        assert!(!hide_on_blur(true,true));
    }
    #[test] fn opens_beside_pet_and_stays_inside_negative_coordinate_monitor() {
        assert_eq!(position((100,500,48,48),(0,0,1920,1080),(340,420)),(160,128));
        let (x,y)=position((-30,1050,48,48),(-1920,0,1920,1080),(340,420));
        assert!(x>=-1912&&x+340<=-8&&y>=8&&y+420<=1072);
        let (x,y)=position((20,-20,48,48),(0,0,800,600),(340,420));
        assert!(x>=8&&y>=8);
    }
}

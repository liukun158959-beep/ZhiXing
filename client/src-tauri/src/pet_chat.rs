use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "pet-chat";

fn position(anchor: (i32,i32,i32,i32), area: (i32,i32,i32,i32), size: (i32,i32)) -> (i32,i32) {
    let (x,y,w,h)=anchor; let (left,top,width,height)=area; let (cw,ch)=size;
    let right=x+w+12;
    let desired=if right+cw <= left+width-8 { right } else { x-cw-12 };
    (desired.clamp(left+8,(left+width-cw-8).max(left+8)), (y+h-ch).clamp(top+8,(top+height-ch-8).max(top+8)))
}

#[tauri::command]
pub async fn set_pet_chat_visible(app: AppHandle, visible: bool) -> Result<(),String> {
    if !visible {
        if let Some(chat)=app.get_webview_window(LABEL) { chat.emit("pet-chat-visible",false).map_err(|e|e.to_string())?;chat.hide().map_err(|e|e.to_string())?; }
        return Ok(());
    }
    let chat=if let Some(chat)=app.get_webview_window(LABEL) { chat } else {
        let dev_url=app.config().build.dev_url.clone();
        let chat=WebviewWindowBuilder::new(&app,LABEL,WebviewUrl::App("pet-chat.html".into()))
            .title("tebb 对话").inner_size(340.,420.).min_inner_size(300.,340.)
            .decorations(false).always_on_top(true).skip_taskbar(true).visible(false)
            // This local credential-bearing webview must never navigate into remote content.
            .on_navigation(move|url|url.path()=="/pet-chat.html" && (
                (url.scheme()=="tauri" && url.host_str()==Some("localhost")) ||
                (url.scheme()=="http" && url.host_str()==Some("tauri.localhost") && url.port_or_known_default()==Some(80)) ||
                dev_url.as_ref().is_some_and(|dev|dev.scheme()==url.scheme()&&dev.host_str()==url.host_str()&&dev.port_or_known_default()==url.port_or_known_default())
            ))
            .build().map_err(|e|e.to_string())?;
        let close=chat.clone();
        chat.on_window_event(move|event|if let tauri::WindowEvent::CloseRequested{api,..}=event { api.prevent_close();let _=close.emit("pet-chat-visible",false);let _=close.hide(); });
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
    chat.emit("pet-chat-visible",true).map_err(|e|e.to_string())?;
    chat.set_focus().map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::position;
    #[test] fn opens_beside_pet_and_stays_inside_negative_coordinate_monitor() {
        assert_eq!(position((100,500,48,48),(0,0,1920,1080),(340,420)),(160,128));
        let (x,y)=position((-30,1050,48,48),(-1920,0,1920,1080),(340,420));
        assert!(x>=-1912&&x+340<=-8&&y>=8&&y+420<=1072);
        let (x,y)=position((20,-20,48,48),(0,0,800,600),(340,420));
        assert!(x>=8&&y>=8);
    }
}

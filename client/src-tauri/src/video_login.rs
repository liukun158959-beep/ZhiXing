//! Dedicated remote windows have persistent profiles and no access to local IPC.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
static POPUP_ID: AtomicU64 = AtomicU64::new(1);

fn platform_info(platform: &str) -> Result<(&'static str, &'static str), String> {
    match platform {
        "Bilibili" => Ok(("video-bilibili", "https://www.bilibili.com/")),
        "YouTube" => Ok(("video-youtube", "https://www.youtube.com/")),
        _ => Err("请选择 Bilibili 或 YouTube。".into()),
    }
}

fn allowed_domain(platform: &str, domain: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    let roots: &[&str] = if platform == "Bilibili" {
        &["bilibili.com"]
    } else {
        &["youtube.com", "google.com"]
    };
    roots
        .iter()
        .any(|root| domain == *root || domain.ends_with(&format!(".{root}")))
}

fn allowed_navigation(platform: &str, url: &Url, blank: bool) -> bool {
    if blank && url.as_str() == "about:blank" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    let captcha = platform == "Bilibili"
        && ["geetest.com", "geevisit.com"]
            .iter()
            .any(|root| host == *root || host.ends_with(&format!(".{root}")));
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (allowed_domain(platform, host) || captcha)
}

fn login_target(platform: &str, video: Option<&str>) -> Result<Url, String> {
    platform_info(platform)?;
    let mut target = Url::parse(if platform == "Bilibili" {
        "https://passport.bilibili.com/login"
    } else {
        "https://accounts.google.com/ServiceLogin"
    })
    .unwrap();
    let destination = video_target(platform, video.unwrap_or(""))?
        .unwrap_or(Url::parse(platform_info(platform)?.1).unwrap());
    if platform == "Bilibili" {
        target
            .query_pairs_mut()
            .append_pair("gourl", destination.as_str())
            .append_pair("source", "main_web");
    } else {
        target
            .query_pairs_mut()
            .append_pair("continue", "https://www.youtube.com/");
    }
    Ok(target)
}

fn video_target(platform: &str, text: &str) -> Result<Option<Url>, String> {
    platform_info(platform)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let target = Url::parse(text.trim()).map_err(|_| "视频链接不正确。")?;
    let host = target.host_str().unwrap_or("");
    let valid = match platform {
        "Bilibili" => {
            ["www.bilibili.com", "bilibili.com", "m.bilibili.com"].contains(&host)
                && target.path().starts_with("/video/")
        }
        "YouTube" => {
            (["www.youtube.com", "youtube.com", "m.youtube.com"].contains(&host)
                && (target.path() == "/watch"
                    || target.path().starts_with("/shorts/")
                    || target.path().starts_with("/live/")))
                || host == "youtu.be"
        }
        _ => false,
    };
    if !valid
        || target.scheme() != "https"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.port().is_some()
    {
        // A URL from the other platform is ignored when opening this platform's login page.
        return Ok(None);
    }
    Ok(Some(if host == "youtu.be" {
        Url::parse(&format!(
            "https://www.youtube.com/watch?v={}",
            target.path().trim_matches('/')
        ))
        .unwrap()
    } else {
        target
    }))
}

fn login_window(
    app: &AppHandle,
    platform: &str,
    visible: bool,
    proxy: Option<String>,
) -> Result<WebviewWindow, String> {
    let (label, home) = platform_info(platform)?;
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }
    let profile = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法创建视频登录目录。")?
        .join(label);
    std::fs::create_dir_all(&profile).map_err(|_| "无法创建视频登录目录。")?;
    let target = platform.to_string();
    let popup_platform = platform.to_string();
    let popup_app = app.clone();
    let popup_profile = profile.clone();
    let mut builder =
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(Url::parse(home).unwrap()))
            .title(format!("tebb · {platform} 登录与视频浏览"))
            .inner_size(1080.0, 760.0)
            .visible(visible)
            .data_directory(profile)
            .on_navigation(move |url| allowed_navigation(&target, url, false))
            .on_new_window(move |url, features| {
                // Preserve window.opener and the shared profile for authentication callbacks.
                if allowed_navigation(&popup_platform, &url, true) {
                    let child_platform = popup_platform.clone();
                    let child_label =
                        format!("{label}-popup-{}", POPUP_ID.fetch_add(1, Ordering::Relaxed));
                    let child = WebviewWindowBuilder::new(
                        &popup_app,
                        child_label,
                        WebviewUrl::External(Url::parse("about:blank").unwrap()),
                    )
                    .title(format!("tebb · {popup_platform} 验证与浏览"))
                    .inner_size(1000.0, 720.0)
                    .data_directory(popup_profile.clone())
                    .window_features(features)
                    .on_navigation(move |url| allowed_navigation(&child_platform, url, true))
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .build();
                    if let Ok(window) = child {
                        return tauri::webview::NewWindowResponse::Create { window };
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            });
    if let Some(proxy) = proxy.filter(|s| !s.is_empty()) {
        let proxy = Url::parse(&proxy).map_err(|_| "视频代理地址不正确。")?;
        if !matches!(proxy.scheme(), "http" | "https")
            || proxy.host_str().is_none()
            || !proxy.username().is_empty()
            || proxy.password().is_some()
            || !matches!(proxy.path(), "" | "/")
            || proxy.query().is_some()
            || proxy.fragment().is_some()
        {
            return Err("视频代理地址不正确。".into());
        }
        builder = builder.proxy_url(proxy);
    }
    builder
        .build()
        .map_err(|_| "视频窗口创建失败，请重启 tebb 后重试。".into())
}

#[tauri::command]
pub async fn open_video_login(
    app: AppHandle,
    platform: String,
    url: Option<String>,
    proxy: Option<String>,
    purpose: Option<String>,
) -> Result<(), String> {
    // WebView2 operations must run outside a synchronous command / UI thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let target = match purpose.as_deref().unwrap_or("login") {
            "login" => login_target(&platform, url.as_deref())?,
            "video" => video_target(&platform, url.as_deref().unwrap_or(""))?
                .unwrap_or(Url::parse(platform_info(&platform)?.1).unwrap()),
            _ => return Err("视频窗口入口不正确。".into()),
        };
        let window = login_window(&app, &platform, true, proxy)?;
        window.navigate(target).map_err(|_| "视频页面打开失败。")?;
        window.show().map_err(|_| "视频窗口显示失败。")?;
        window.set_focus().map_err(|_| "视频窗口显示失败。".into())
    })
    .await
    .map_err(|_| "视频窗口打开失败。")?
}

#[derive(Serialize)]
pub struct LoginCookie {
    domain: String,
    name: String,
    value: String,
    path: String,
    expires: i64,
    secure: bool,
    http_only: bool,
}

#[tauri::command]
pub async fn capture_video_login(
    app: AppHandle,
    platform: String,
) -> Result<Vec<LoginCookie>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (label, _) = platform_info(&platform)?;
        let window = app
            .get_webview_window(label)
            .ok_or("请先打开视频登录窗口，完成登录后保持窗口打开。")?;
        let cookies = window
            .cookies()
            .map_err(|_| "读取视频窗口登录态失败，请重试。")?;
        Ok(cookies
            .into_iter()
            .filter(|c| allowed_domain(&platform, c.domain().unwrap_or("")))
            .map(|c| LoginCookie {
                domain: c.domain().unwrap_or("").into(),
                name: c.name().into(),
                value: c.value().into(),
                path: c.path().unwrap_or("/").into(),
                expires: c
                    .expires_datetime()
                    .map(|d| d.unix_timestamp().max(0))
                    .unwrap_or(0),
                secure: c.secure().unwrap_or(false),
                http_only: c.http_only().unwrap_or(false),
            })
            .collect())
    })
    .await
    .map_err(|_| "读取视频登录态失败。")?
}

#[tauri::command]
pub async fn clear_video_login_window(app: AppHandle, platform: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let window = login_window(&app, &platform, false, None)?;
        let (label, _) = platform_info(&platform)?;
        for child in app
            .webview_windows()
            .values()
            .filter(|w| w.label().starts_with(&format!("{label}-popup-")))
        {
            child.close().map_err(|_| "关闭视频验证窗口失败。")?;
        }
        // DeleteCookie is queued on the UI thread; the subsequent cookie read waits for completion.
        for cookie in window
            .cookies()
            .map_err(|_| "清除视频窗口登录态失败，请重试。")?
        {
            window
                .delete_cookie(cookie)
                .map_err(|_| "清除视频窗口登录态失败，请重试。")?;
        }
        if window
            .cookies()
            .map_err(|_| "核实视频登录态清除结果失败。")?
            .iter()
            .any(|c| {
                matches!(
                    c.name(),
                    "SESSDATA" | "SID" | "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID"
                )
            })
        {
            return Err("视频窗口仍有登录信息，请重试清除。".into());
        }
        // The dedicated profile contains only this platform. Clear storage and cache as well.
        window
            .clear_all_browsing_data()
            .map_err(|_| "清除视频窗口登录态失败，请重试。")?;
        window.close().map_err(|_| "关闭视频窗口失败。".into())
    })
    .await
    .map_err(|_| "清除视频登录态失败。")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domains_are_platform_scoped() {
        assert!(allowed_domain("Bilibili", ".bilibili.com"));
        assert!(!allowed_domain("Bilibili", "bilibili.com.evil.test"));
        assert!(!allowed_domain("Bilibili", "google.com"));
        assert!(allowed_domain("YouTube", "accounts.google.com"));
        assert!(!allowed_domain("YouTube", "notgoogle.com"));
        assert!(platform_info("../../other").is_err());
    }
    #[test]
    fn login_uses_official_passport_and_only_trusted_return_urls() {
        let video = "https://www.bilibili.com/video/BV1ojfDBSEPv";
        let target = login_target("Bilibili", Some(video)).unwrap();
        assert_eq!(target.host_str(), Some("passport.bilibili.com"));
        assert_eq!(target.path(), "/login");
        assert!(target
            .query_pairs()
            .any(|(key, value)| key == "gourl" && value == video));
        for invalid in [
            "file:///C:/private",
            "https://localhost/video/a",
            "https://bilibili.com.evil/video/a",
            "https://user:password@www.bilibili.com/video/a",
            "https://www.bilibili.com:999/video/a",
        ] {
            assert!(video_target("Bilibili", invalid).unwrap().is_none());
            assert!(!login_target("Bilibili", Some(invalid))
                .unwrap()
                .as_str()
                .contains("private"));
        }
        assert_eq!(
            video_target("Bilibili", video).unwrap().unwrap().as_str(),
            video
        );
        assert_eq!(
            video_target("YouTube", "https://youtu.be/abcdefghijk")
                .unwrap()
                .unwrap()
                .as_str(),
            "https://www.youtube.com/watch?v=abcdefghijk"
        );
    }
    #[test]
    fn verification_navigation_does_not_expand_cookie_or_ipc_scope() {
        assert!(allowed_navigation(
            "Bilibili",
            &Url::parse("https://api.geetest.com/verify").unwrap(),
            false
        ));
        assert!(allowed_navigation(
            "Bilibili",
            &Url::parse("https://static.geevisit.com/").unwrap(),
            false
        ));
        assert!(!allowed_domain("Bilibili", "api.geetest.com"));
        assert!(!allowed_navigation(
            "YouTube",
            &Url::parse("https://api.geetest.com/").unwrap(),
            false
        ));
        assert!(allowed_navigation(
            "Bilibili",
            &Url::parse("about:blank").unwrap(),
            true
        ));
        assert!(!allowed_navigation(
            "Bilibili",
            &Url::parse("about:blank").unwrap(),
            false
        ));
        for url in [
            "https://geetest.com.evil/",
            "http://api.geetest.com/",
            "file:///C:/secret",
            "http://127.0.0.1:9000/",
            "tauri://localhost/",
        ] {
            assert!(!allowed_navigation(
                "Bilibili",
                &Url::parse(url).unwrap(),
                true
            ));
        }
    }
}

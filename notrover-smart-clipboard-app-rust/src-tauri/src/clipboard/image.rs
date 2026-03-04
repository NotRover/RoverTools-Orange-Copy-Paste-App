//! Clipboard image utilities: reading from the OS clipboard and encoding
//! to/from `data:image/png;base64,…` URLs for use in the JS frontend.
//!
//! ## Windows clipboard format strategy
//!
//! `arboard` only reads `CF_DIB`/`CF_DIBV5`.  Modern apps (browsers, Snipping
//! Tool, Explorer) typically write `CF_PNG` or expose images as dropped files
//! (`CF_HDROP`).  [`read_image_from_clipboard`] tries each format in priority
//! order before falling back to arboard.

use base64::{engine::general_purpose::STANDARD as B64, Engine};

#[cfg(windows)]
fn image_data_url_from_raw_bytes(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        "image/jpeg"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        return None;
    };

    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[cfg(windows)]
unsafe fn read_hglobal_bytes(h: *mut core::ffi::c_void) -> Option<Vec<u8>> {
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    if h.is_null() {
        return None;
    }

    let ptr = GlobalLock(h);
    if ptr.is_null() {
        return None;
    }

    let size = GlobalSize(h);
    let bytes = if size == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(ptr as *const u8, size).to_vec()
    };

    GlobalUnlock(h);
    Some(bytes)
}

#[cfg(windows)]
fn try_read_registered_image_format(format_name: &str) -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    };

    unsafe {
        let mut wide: Vec<u16> = format_name.encode_utf16().collect();
        wide.push(0);

        let fmt = RegisterClipboardFormatW(wide.as_ptr());
        if fmt == 0 {
            return None;
        }

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }

        let handle = GetClipboardData(fmt);
        if handle.is_null() {
            CloseClipboard();
            return None;
        }

        let bytes = read_hglobal_bytes(handle);
        CloseClipboard();

        let bytes = bytes?;
        if bytes.is_empty() {
            return None;
        }

        image_data_url_from_raw_bytes(&bytes)
    }
}

#[cfg(windows)]
fn try_read_cf_hdrop_image() -> Option<String> {
    use std::path::PathBuf;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    const CF_HDROP: u32 = 15;

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }

        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            CloseClipboard();
            return None;
        }

        // UINT(-1) returns the number of files in the drop handle.
        let file_count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
        if file_count == 0 {
            CloseClipboard();
            return None;
        }

        let mut candidate_paths: Vec<PathBuf> = Vec::new();

        for index in 0..file_count {
            let len = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }

            // Include trailing NUL.
            let mut buf = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(handle, index, buf.as_mut_ptr(), buf.len() as u32);
            if copied == 0 {
                continue;
            }

            let path = String::from_utf16_lossy(&buf[..copied as usize]);
            if !path.is_empty() {
                candidate_paths.push(PathBuf::from(path));
            }
        }

        CloseClipboard();

        for path in candidate_paths {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };

            if let Some(data_url) = image_data_url_from_raw_bytes(&bytes) {
                return Some(data_url);
            }
        }

        None
    }
}

/// Returns `true` if any image format is currently available on the clipboard,
/// without reading pixel data.  Used as a cheap pre-flight check before the
/// image read+retry loop.
///
/// `IsClipboardFormatAvailable` does not require `OpenClipboard` to be called.
#[cfg(windows)]
pub fn any_image_format_available() -> bool {
    use windows_sys::Win32::System::DataExchange::{
        IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    const CF_HDROP: u32 = 15;

    unsafe {
        let wide: Vec<u16> = "PNG\0".encode_utf16().collect();
        let cf_png = RegisterClipboardFormatW(wide.as_ptr());
        (cf_png != 0 && IsClipboardFormatAvailable(cf_png) != 0)
            || IsClipboardFormatAvailable(CF_DIB) != 0
            || IsClipboardFormatAvailable(CF_DIBV5) != 0
            || IsClipboardFormatAvailable(CF_HDROP) != 0
    }
}

#[cfg(not(windows))]
pub fn any_image_format_available() -> bool {
    false
}

/// Read any image from the OS clipboard, trying formats in priority order.
///
/// 1. Registered custom names: `CF_PNG` (`"PNG"`), `image/png`, `image/jpeg`,
///    `image/webp`, `image/bmp`, `JFIF` — covers browsers, Snipping Tool, etc.
/// 2. `CF_HDROP` — image file exposed as a shell file-drop object.
/// 3. `arboard` — reads `CF_DIBV5`/`CF_DIB` for screenshots and classic Win32 apps.
///
/// Returns a `data:<mime>;base64,…` URL or `None`.
pub fn read_image_from_clipboard() -> Option<String> {
    #[cfg(windows)]
    {
        for fmt_name in [
            "PNG",
            "image/png",
            "image/jpeg",
            "image/jpg",
            "image/webp",
            "image/bmp",
            "JFIF",
        ] {
            if let Some(data_url) = try_read_registered_image_format(fmt_name) {
                return Some(data_url);
            }
        }

        if let Some(data_url) = try_read_cf_hdrop_image() {
            return Some(data_url);
        }
    }

    // arboard fallback: CF_DIBV5 / CF_DIB (screenshots, classic Win32 apps)
    let mut cb = arboard::Clipboard::new().ok()?;
    cb.get_image()
        .ok()
        .and_then(|img| image_data_to_data_url(img.width, img.height, img.bytes.into_owned()))
}

// arboard image → data-URL

/// Encode raw RGBA pixel data (from `arboard`) into a `data:image/png;base64,…`
/// string suitable for use as an `<img src>`.
///
/// Returns `None` if the pixel data is empty or PNG encoding fails.
pub fn image_data_to_data_url(
    width: usize,
    height: usize,
    mut rgba_bytes: Vec<u8>,
) -> Option<String> {
    use image::RgbaImage;

    if rgba_bytes.is_empty() {
        return None;
    }

    // Windows clipboard images (CF_DIB / CF_BITMAP) are typically 24-bit BGR
    // with no alpha.  arboard fills the alpha byte as 0, making every pixel
    // fully transparent.  Detect this and force alpha=255 so the image is
    // visible in the webview.
    let all_transparent = rgba_bytes.chunks_exact(4).all(|px| px[3] == 0);
    if all_transparent {
        for px in rgba_bytes.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }

    // If the buffer is larger than width*height*4 (e.g. row-padding artefact)
    // truncate to the exact size so RgbaImage::from_raw accepts it.
    let expected = width * height * 4;
    if rgba_bytes.len() > expected {
        rgba_bytes.truncate(expected);
    }

    let img = RgbaImage::from_raw(width as u32, height as u32, rgba_bytes)?;

    let mut png_buf: Vec<u8> = Vec::new();
    match img.write_to(
        &mut std::io::Cursor::new(&mut png_buf),
        image::ImageFormat::Png,
    ) {
        Ok(_) => {}
        Err(_) => return None,
    }

    Some(format!("data:image/png;base64,{}", B64.encode(&png_buf)))
}

// data-URL → arboard image

/// Decode a `data:image/png;base64,…` (or JPEG) string back into raw RGBA
/// pixels for writing to the system clipboard via `arboard`.
///
/// Returns `(width, height, rgba_bytes)` or an error string.
pub fn data_url_to_rgba(data_url: &str) -> Result<(usize, usize, Vec<u8>), String> {
    let b64_data = data_url
        .trim_start_matches("data:image/png;base64,")
        .trim_start_matches("data:image/jpeg;base64,")
        .trim_start_matches("data:image/webp;base64,");

    if b64_data.len() == data_url.len() {
        return Err("Unsupported or missing data-URL prefix".into());
    }

    let raw = B64.decode(b64_data).map_err(|e| e.to_string())?;

    let img = image::load_from_memory(&raw)
        .map_err(|e| e.to_string())?
        .into_rgba8();

    let (w, h) = img.dimensions();
    Ok((w as usize, h as usize, img.into_raw()))
}

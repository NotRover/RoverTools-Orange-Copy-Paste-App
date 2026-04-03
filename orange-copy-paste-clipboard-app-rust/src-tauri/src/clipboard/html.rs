//! Clipboard HTML utilities: reading CF_HTML from the OS clipboard and
//! writing it back with the required Windows header format.
//!
//! ## Windows CF_HTML format
//!
//! CF_HTML is a registered clipboard format (`"HTML Format"`) with a specific
//! header containing byte offsets:
//!
//! ```text
//! Version:0.9
//! StartHTML:000000105
//! EndHTML:000000
//! StartFragment:000000
//! EndFragment:000000
//! <html><body>
//! <!--StartFragment-->
//! <actual html content>
//! <!--EndFragment-->
//! </body></html>
//! ```

/// Check if CF_HTML is available on the clipboard.
#[cfg(windows)]
pub fn any_html_format_available() -> bool {
    use windows_sys::Win32::System::DataExchange::{
        IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };
    unsafe {
        let wide: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let fmt = RegisterClipboardFormatW(wide.as_ptr());
        fmt != 0 && IsClipboardFormatAvailable(fmt) != 0
    }
}

#[cfg(not(windows))]
pub fn any_html_format_available() -> bool {
    false
}

/// Read the HTML fragment from CF_HTML on the clipboard.
/// Returns the HTML fragment (between StartFragment/EndFragment markers).
#[cfg(windows)]
pub fn read_html_from_clipboard() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    unsafe {
        let wide: Vec<u16> = "HTML Format\0".encode_utf16().collect();
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

        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            CloseClipboard();
            return None;
        }

        let size = GlobalSize(handle);
        let bytes = if size == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(ptr as *const u8, size).to_vec()
        };

        GlobalUnlock(handle);
        CloseClipboard();

        if bytes.is_empty() {
            return None;
        }

        // CF_HTML is UTF-8 with a header containing byte offsets.
        let raw = String::from_utf8_lossy(&bytes);

        // Parse StartFragment / EndFragment offsets
        let start_frag = parse_header_value(&raw, "StartFragment:")?;
        let end_frag = parse_header_value(&raw, "EndFragment:")?;

        if start_frag >= end_frag || end_frag > bytes.len() {
            return None;
        }

        let fragment = String::from_utf8_lossy(&bytes[start_frag..end_frag]).to_string();

        // Only treat as rich HTML worth capturing separately
        if !is_rich_content(&fragment) {
            return None;
        }

        Some(fragment)
    }
}

#[cfg(not(windows))]
pub fn read_html_from_clipboard() -> Option<String> {
    None
}

/// Write HTML content back to the clipboard as CF_HTML + CF_UNICODETEXT.
/// The plain text fallback is written alongside so paste targets that don't
/// support HTML still get usable content.
#[cfg(windows)]
pub fn write_html_to_clipboard(html_fragment: &str, plain_text: &str) -> Result<(), String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };

    const CF_UNICODETEXT: u32 = 13;
    const OPEN_RETRIES: usize = 10;
    const OPEN_RETRY_DELAY_MS: u64 = 50;

    // Build CF_HTML blob
    let cf_html_blob = build_cf_html(html_fragment);

    // Build CF_UNICODETEXT blob (UTF-16LE + NUL)
    let wide: Vec<u16> = plain_text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let wide_bytes = wide.len() * 2;

    unsafe {
        // Open clipboard with retry
        let mut opened = false;
        for attempt in 0..OPEN_RETRIES {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            if attempt + 1 < OPEN_RETRIES {
                std::thread::sleep(std::time::Duration::from_millis(OPEN_RETRY_DELAY_MS));
            }
        }
        if !opened {
            return Err("OpenClipboard failed after retries".into());
        }

        if EmptyClipboard() == 0 {
            CloseClipboard();
            return Err("EmptyClipboard failed".into());
        }

        // Write CF_HTML
        let wide_fmt: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let cf_html = RegisterClipboardFormatW(wide_fmt.as_ptr());
        if cf_html != 0 {
            let hmem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, cf_html_blob.len());
            if !hmem.is_null() {
                let ptr = GlobalLock(hmem) as *mut u8;
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(cf_html_blob.as_ptr(), ptr, cf_html_blob.len());
                    GlobalUnlock(hmem);
                    if SetClipboardData(cf_html, hmem).is_null() {
                        // Non-critical, continue with CF_UNICODETEXT
                    }
                }
            }
        }

        // Write CF_UNICODETEXT
        let hmem_text = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, wide_bytes);
        if !hmem_text.is_null() {
            let ptr = GlobalLock(hmem_text) as *mut u8;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr, wide_bytes);
                GlobalUnlock(hmem_text);
                let _ = SetClipboardData(CF_UNICODETEXT, hmem_text);
            }
        }

        CloseClipboard();
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn write_html_to_clipboard(_html_fragment: &str, _plain_text: &str) -> Result<(), String> {
    Err("HTML clipboard write not supported on this platform".into())
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Parse a numeric value from a CF_HTML header line like "StartFragment:000000123".
fn parse_header_value(raw: &str, key: &str) -> Option<usize> {
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
}

/// Determine if the HTML fragment is genuinely rich content worth capturing
/// as HTML rather than plain text or image.
///
/// We ONLY capture as HTML when the fragment contains:
///   • Inline images (`<img`) mixed with substantial text (≥ 20 chars after
///     stripping all tags) — the main use-case for Word / Teams rich pastes.
///   • Table data (`<table` with `<td`).
///
/// This intentionally rejects:
///   • Pure `<img>` tags with no text (let the image capture path handle it).
///   • Plain text wrapped in `<span style="...">` (the text capture is better).
fn is_rich_content(html: &str) -> bool {
    let lower = html.to_lowercase();

    // Tables with actual cell content are always rich.
    if lower.contains("<table") && lower.contains("<td") {
        return true;
    }

    // Inline images: only if there is also meaningful text alongside them.
    if lower.contains("<img") {
        let text_only = strip_tags(html);
        // 20 chars ≈ "a couple of words" — enough to distinguish a caption
        // from an empty/whitespace-only fragment.
        return text_only.trim().len() >= 20;
    }

    false
}

/// Crude tag stripper — removes everything between `<` and `>` to yield
/// the raw text content of an HTML fragment.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut inside = false;
    for ch in html.chars() {
        if ch == '<' {
            inside = true;
        } else if ch == '>' {
            inside = false;
        } else if !inside {
            out.push(ch);
        }
    }
    out
}

/// Build the full CF_HTML blob with the required header and byte offsets.
fn build_cf_html(fragment: &str) -> Vec<u8> {
    // The header template — offsets are padded to 10 digits
    let prefix = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let html_start = "<html><body>\r\n<!--StartFragment-->";
    let html_end = "<!--EndFragment-->\r\n</body></html>";

    // Calculate byte offsets
    let start_html = prefix.len();
    let start_fragment = start_html + html_start.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + html_end.len();

    // Build the header with actual offsets
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    );

    let mut blob = Vec::with_capacity(end_html);
    blob.extend_from_slice(header.as_bytes());
    blob.extend_from_slice(html_start.as_bytes());
    blob.extend_from_slice(fragment.as_bytes());
    blob.extend_from_slice(html_end.as_bytes());
    blob
}

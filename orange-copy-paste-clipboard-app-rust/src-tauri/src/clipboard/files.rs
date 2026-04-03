//! Clipboard file-list utilities (CF_HDROP on Windows).

#[cfg(windows)]
const CF_HDROP: u32 = 15;

#[cfg(windows)]
pub fn any_file_format_available() -> bool {
    unsafe { windows_sys::Win32::System::DataExchange::IsClipboardFormatAvailable(CF_HDROP) != 0 }
}

#[cfg(not(windows))]
pub fn any_file_format_available() -> bool {
    false
}

#[cfg(windows)]
pub fn read_files_from_clipboard() -> Option<Vec<String>> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }

        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            CloseClipboard();
            return None;
        }

        let file_count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
        if file_count == 0 {
            CloseClipboard();
            return None;
        }

        let mut files = Vec::with_capacity(file_count as usize);

        for index in 0..file_count {
            let len = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }

            let mut buf = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(handle, index, buf.as_mut_ptr(), buf.len() as u32);
            if copied == 0 {
                continue;
            }

            let path = String::from_utf16_lossy(&buf[..copied as usize]);
            if !path.is_empty() {
                files.push(path);
            }
        }

        CloseClipboard();

        if files.is_empty() {
            None
        } else {
            Some(files)
        }
    }
}

#[cfg(not(windows))]
pub fn read_files_from_clipboard() -> Option<Vec<String>> {
    None
}

pub fn files_to_content(paths: &[String]) -> String {
    paths.join("\n")
}

pub fn content_to_files(content: &str) -> Vec<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(windows)]
pub fn write_files_to_clipboard(paths: &[String]) -> Result<(), String> {
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows_sys::Win32::UI::Shell::DROPFILES;

    if paths.is_empty() {
        return Err("No files provided".into());
    }

    let mut utf16_block: Vec<u16> = Vec::new();
    for path in paths {
        if path.trim().is_empty() {
            continue;
        }

        utf16_block.extend(path.encode_utf16());
        utf16_block.push(0);
    }
    utf16_block.push(0);

    if utf16_block.len() <= 1 {
        return Err("No valid file paths provided".into());
    }

    let dropfiles = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: 0,
        fWide: 1,
    };

    let header_size = size_of::<DROPFILES>();
    let names_size = utf16_block.len() * size_of::<u16>();
    let total_size = header_size + names_size;

    unsafe {
        let hmem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size);
        if hmem.is_null() {
            return Err("GlobalAlloc failed".into());
        }

        let ptr = GlobalLock(hmem) as *mut u8;
        if ptr.is_null() {
            return Err("GlobalLock failed".into());
        }

        std::ptr::copy_nonoverlapping(
            &dropfiles as *const DROPFILES as *const u8,
            ptr,
            header_size,
        );
        std::ptr::copy_nonoverlapping(
            utf16_block.as_ptr() as *const u8,
            ptr.add(header_size),
            names_size,
        );

        GlobalUnlock(hmem);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed".into());
        }

        if EmptyClipboard() == 0 {
            CloseClipboard();
            return Err("EmptyClipboard failed".into());
        }

        if SetClipboardData(CF_HDROP, hmem).is_null() {
            CloseClipboard();
            return Err("SetClipboardData(CF_HDROP) failed".into());
        }

        CloseClipboard();
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn write_files_to_clipboard(_paths: &[String]) -> Result<(), String> {
    Err("File clipboard writes are currently only supported on Windows".into())
}

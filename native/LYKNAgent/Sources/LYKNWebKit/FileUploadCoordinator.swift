import Foundation
import LYKNAgentCore
import WebKit

/// File upload — the CDP replacement.
///
/// Under Electron this was the codebase's only use of the Chrome DevTools
/// Protocol (`DOM.setFileInputFiles`). There are two replacements, and which
/// one applies depends on whether trusted input is available:
///
/// 1. **`runOpenPanelWith` (preferred, macOS-only).** The delegate hands us a
///    completion handler taking `[URL]?` and we call it immediately with real
///    file URLs, never showing a panel. The page gets genuine `File` objects
///    with correct name/size/type and working `FileReader`/`FormData`/
///    streaming — functionally equivalent to `DOM.setFileInputFiles`. **But
///    the panel only fires on a user-activated click**, so this path requires
///    `NativeEventBackend`. This single feature is what pulls trusted input
///    onto the critical path.
///
/// 2. **`DataTransfer` injection (fallback).** Build a `File` in-page and
///    assign `input.files`. Works for pages that read `input.files`/`FormData`;
///    fails for pages requiring a trusted `change` event or user activation.
///
/// Sandboxed builds copy the file into the app container first and pass that
/// URL, which sidesteps security-scoped bookmarks entirely.
/// See migration doc §4.
@MainActor
public final class FileUploadCoordinator {
    private let tab: BrowserTab
    private let containerDirectory: URL

    public init(tab: BrowserTab, containerDirectory: URL? = nil) {
        self.tab = tab
        self.containerDirectory =
            containerDirectory
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("lykn-uploads")
    }

    /// Copy into the app container so a sandboxed process can read it back.
    private func stage(_ source: URL) throws -> URL {
        try FileManager.default.createDirectory(
            at: containerDirectory, withIntermediateDirectories: true
        )
        let destination = containerDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(source.pathExtension)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    /// Attach files to a file input, choosing the best available mechanism.
    ///
    /// - Parameters:
    ///   - selector: CSS selector for the `<input type=file>`.
    ///   - files: source URLs on disk.
    ///   - backend: when it produces trusted events, the open-panel path is
    ///     used; otherwise this falls back to `DataTransfer` injection.
    public func attach(
        files: [URL],
        toInputMatching selector: String,
        using backend: ActuationBackend
    ) async -> ActionResult {
        guard !files.isEmpty else { return .failure("no_files") }

        let staged: [URL]
        do {
            staged = try files.map { try stage($0) }
        } catch {
            return .failure("stage_failed:\(error.localizedDescription)")
        }

        if backend.producesTrustedEvents {
            // Stage the files, then click the input for real. WebKit raises the
            // open panel, our delegate answers it immediately, and the page
            // receives genuine File objects.
            tab.pendingUploadFiles = staged
            let point = await tab.bridge.dictionary(
                "return __lykn.resolveStrict({selector: selector, strictTarget: true});",
                arguments: ["selector": selector]
            )
            if let point, point["ok"] as? Bool == true,
                let x = point["x"] as? Double, let y = point["y"] as? Double {
                let clicked = await backend.click(at: CGPoint(x: x, y: y), target: tab)
                if clicked.ok {
                    // The panel is answered synchronously by the delegate; give
                    // WebKit a beat to deliver the files to the page.
                    try? await Task.sleep(for: .milliseconds(250))
                    tab.pendingUploadFiles = []
                    return ActionResult(
                        ok: true, type: "attach_files",
                        label: staged.map(\.lastPathComponent).joined(separator: ", "),
                        via: "open_panel"
                    )
                }
            }
            tab.pendingUploadFiles = []
        }

        return await attachViaDataTransfer(files: staged, selector: selector)
    }

    /// `DataTransfer` injection. Bytes travel as base64 through
    /// `callAsyncJavaScript` arguments — costly for large files, which is why
    /// the open-panel path is preferred whenever trusted input exists.
    private func attachViaDataTransfer(files: [URL], selector: String) async -> ActionResult {
        var payload: [[String: String]] = []
        for url in files {
            guard let data = try? Data(contentsOf: url) else {
                return .failure("unreadable_file:\(url.lastPathComponent)")
            }
            payload.append(
                [
                    "name": url.lastPathComponent,
                    "type": Self.mimeType(for: url),
                    "base64": data.base64EncodedString(),
                ]
            )
        }

        let script = """
            var input = document.querySelector(selector);
            if (!input) return { ok: false, error: 'input_not_found' };
            var dt = new DataTransfer();
            for (var i = 0; i < files.length; i++) {
                var spec = files[i];
                var binary = atob(spec.base64);
                var bytes = new Uint8Array(binary.length);
                for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                dt.items.add(new File([bytes], spec.name, { type: spec.type }));
            }
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, count: dt.files.length };
            """

        let result = await tab.bridge.dictionary(
            script, arguments: ["selector": selector, "files": payload]
        )
        guard let result, result["ok"] as? Bool == true else {
            return .failure((result?["error"] as? String) ?? "data_transfer_failed")
        }
        return ActionResult(
            ok: true,
            type: "attach_files",
            // The page got File objects but no trusted activation — anything
            // gated on a trusted `change` will still refuse.
            unverified: true,
            via: "data_transfer"
        )
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "txt": return "text/plain"
        case "csv": return "text/csv"
        case "json": return "application/json"
        case "zip": return "application/zip"
        case "doc": return "application/msword"
        case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xls": return "application/vnd.ms-excel"
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        default: return "application/octet-stream"
        }
    }
}

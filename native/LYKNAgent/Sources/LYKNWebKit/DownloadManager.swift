import AppKit
import Foundation
import WebKit

/// Downloads via `WKDownloadDelegate`.
///
/// Ports `session.on("will-download")` + `item.setSavePath`, including the
/// de-duplication of colliding filenames. One thing is genuinely better here:
/// `WKWebView.startDownload(using:)` fetches with the web view's own cookies
/// and session, which was awkward in Electron (migration doc §4).
@MainActor
public final class DownloadManager: NSObject, WKDownloadDelegate {
    public static let shared = DownloadManager()

    public struct Record: Sendable, Identifiable {
        public let id: UUID
        public var filename: String
        public var destination: URL
        public var finished: Bool
        public var failed: String?
    }

    public private(set) var records: [Record] = []
    public var onChange: (() -> Void)?

    /// Destination directory. The sandbox needs
    /// `com.apple.security.files.downloads.read-write` for `~/Downloads`.
    public var downloadsDirectory: URL = FileManager.default.urls(
        for: .downloadsDirectory, in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())

    private var byDownload: [ObjectIdentifier: UUID] = [:]

    /// Fetch a URL as a download using the web view's session and cookies.
    public func start(_ url: URL, from webView: WKWebView) async {
        let download = await webView.startDownload(using: URLRequest(url: url))
        download.delegate = self
    }

    /// The destination must not already exist and its parent must be writable
    /// by the sandbox, so collisions get a numeric suffix rather than failing.
    func uniqueDestination(for filename: String) -> URL {
        let base = downloadsDirectory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: base.path) else { return base }
        let ext = base.pathExtension
        let stem = base.deletingPathExtension().lastPathComponent
        var index = 1
        while index < 1000 {
            let candidate = downloadsDirectory.appendingPathComponent(
                ext.isEmpty ? "\(stem) (\(index))" : "\(stem) (\(index)).\(ext)"
            )
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            index += 1
        }
        return downloadsDirectory.appendingPathComponent(UUID().uuidString + "-" + filename)
    }

    public func revealInFinder(_ record: Record) {
        NSWorkspace.shared.activateFileViewerSelecting([record.destination])
    }

    // MARK: - WKDownloadDelegate

    public func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        try? FileManager.default.createDirectory(
            at: downloadsDirectory, withIntermediateDirectories: true
        )
        let destination = uniqueDestination(for: suggestedFilename)
        let id = UUID()
        byDownload[ObjectIdentifier(download)] = id
        records.append(
            Record(
                id: id, filename: destination.lastPathComponent, destination: destination,
                finished: false, failed: nil
            )
        )
        onChange?()
        completionHandler(destination)
    }

    public func downloadDidFinish(_ download: WKDownload) {
        guard let id = byDownload.removeValue(forKey: ObjectIdentifier(download)),
            let index = records.firstIndex(where: { $0.id == id })
        else { return }
        records[index].finished = true
        onChange?()
    }

    public func download(
        _ download: WKDownload,
        didFailWithError error: Error,
        resumeData: Data?
    ) {
        guard let id = byDownload.removeValue(forKey: ObjectIdentifier(download)),
            let index = records.firstIndex(where: { $0.id == id })
        else { return }
        records[index].failed = error.localizedDescription
        onChange?()
    }
}

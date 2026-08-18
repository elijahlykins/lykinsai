import Foundation

/// Thin wrapper over `NSRegularExpression` for the literal patterns ported
/// from the JS runtime.
///
/// Construction traps on a malformed pattern deliberately. Several of these
/// regexes are safety gates — the money, data-destruction and outbound-send
/// classifiers in `Executor` — and a pattern that silently never matched would
/// fail *open*, letting a consequential action run without approval. A crash
/// at first use is the honest failure, and `RegexCatalogTests` compiles every
/// pattern so it can never reach a release build.
public struct RE: Sendable {
    private let regex: NSRegularExpression

    public init(_ pattern: String, caseInsensitive: Bool = true) {
        var options: NSRegularExpression.Options = []
        if caseInsensitive { options.insert(.caseInsensitive) }
        do {
            regex = try NSRegularExpression(pattern: pattern, options: options)
        } catch {
            preconditionFailure("Invalid regex literal \(pattern): \(error)")
        }
    }

    /// JS `re.test(string)`.
    public func test(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return regex.firstMatch(in: value, options: [], range: range) != nil
    }
}

import Foundation

/// Lenient accessors for payloads produced by JavaScript.
///
/// The injected runtime and the model endpoint both omit keys they have
/// nothing to say about, and occasionally send a number where a string is
/// declared. A strict decode would throw away an entire catalog over one odd
/// field, so every read falls back to a default instead.
///
/// `try?` flattens nested optionals (SE-0230), so each of these is a plain
/// `T?` where nil means "absent or undecodable" — a distinction none of the
/// callers need to make.
extension KeyedDecodingContainer {
    func lenientString(_ key: Key, default fallback: String = "") -> String {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let number = try? decodeIfPresent(Double.self, forKey: key) {
            return number == number.rounded() ? String(Int(number)) : String(number)
        }
        return fallback
    }

    func lenientOptionalString(_ key: Key) -> String? {
        try? decodeIfPresent(String.self, forKey: key)
    }

    func lenientBool(_ key: Key, default fallback: Bool = false) -> Bool {
        (try? decodeIfPresent(Bool.self, forKey: key)) ?? fallback
    }

    func lenientOptionalBool(_ key: Key) -> Bool? {
        try? decodeIfPresent(Bool.self, forKey: key)
    }

    func lenientDouble(_ key: Key, default fallback: Double = 0) -> Double {
        (try? decodeIfPresent(Double.self, forKey: key)) ?? fallback
    }

    func lenientOptionalDouble(_ key: Key) -> Double? {
        try? decodeIfPresent(Double.self, forKey: key)
    }

    func lenientStringArray(_ key: Key) -> [String]? {
        try? decodeIfPresent([String].self, forKey: key)
    }
}

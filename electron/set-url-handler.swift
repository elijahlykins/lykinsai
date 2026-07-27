import CoreServices
import Foundation

// Usage: swift set-url-handler.swift <scheme> <bundleId>
// Sets the default macOS handler for a URL scheme (e.g. lykn → ai.lykn.desktop).

guard CommandLine.arguments.count >= 3 else {
  fputs("usage: set-url-handler.swift <scheme> <bundleId>\n", stderr)
  exit(2)
}

let scheme = CommandLine.arguments[1] as CFString
let bundleId = CommandLine.arguments[2] as CFString
let status = LSSetDefaultHandlerForURLScheme(scheme, bundleId)
exit(status == noErr ? 0 : 1)

import AppKit
import LYKNAgentCore
import SwiftUI

/// Hosts the tab manager's container view. Tab web views live inside it, with
/// inactive ones parked offscreen rather than hidden — WebKit throttles
/// rendering for occluded views and would hand back blank snapshots.
struct BrowserStage: NSViewRepresentable {
    let container: NSView

    func makeNSView(context: Context) -> NSView { container }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

struct ContentView: View {
    @EnvironmentObject private var session: AgentSession
    @State private var goal = ""
    @State private var address = ""
    @State private var trustedInput = true
    @State private var handoverNote = ""

    var body: some View {
        HSplitView {
            browserPane
                .frame(minWidth: 640, idealWidth: 900)
            sidebar
                .frame(minWidth: 320, idealWidth: 380, maxWidth: 520)
        }
        .frame(minWidth: 1040, minHeight: 640)
    }

    // MARK: Browser

    private var browserPane: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider()
            addressBar
            Divider()
            BrowserStage(container: session.containerView)
        }
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(session.tabs, id: \.id) { tab in
                    HStack(spacing: 4) {
                        Text(tab.title.isEmpty ? tab.url : tab.title)
                            .lineLimit(1)
                            .font(.caption)
                        Button {
                            session.closeTab(tab.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(tab.active ? Color.accentColor.opacity(0.18) : Color.clear)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { session.selectTab(tab.id) }
                    .frame(maxWidth: 180)
                }
                Button {
                    session.newTab()
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private var addressBar: some View {
        HStack(spacing: 8) {
            TextField("Address", text: $address)
                .textFieldStyle(.roundedBorder)
                .onSubmit { session.navigate(address) }
            Button("Go") { session.navigate(address) }
                .disabled(address.isEmpty)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            goalEntry
            Divider()
            if let approval = session.pendingApproval {
                approvalCard(approval)
                Divider()
            }
            if let handover = session.pendingHandover {
                handoverCard(handover)
                Divider()
            }
            transcript
            Divider()
            statusBar
        }
    }

    private var goalEntry: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Goal").font(.headline)
            TextEditor(text: $goal)
                .font(.body)
                .frame(height: 72)
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3))
                )
            HStack {
                Button(session.isRunning ? "Running…" : "Run") { session.run(goal: goal) }
                    .disabled(session.isRunning || goal.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Stop") { session.cancel() }
                    .disabled(!session.isRunning)
                Spacer()
            }
        }
        .padding(12)
    }

    private func approvalCard(_ approval: AgentSession.PendingApproval) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Approval needed", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(approval.question).font(.body)
            HStack {
                Button("Yes, go ahead") { session.answerApproval(true) }
                    .keyboardShortcut(.defaultAction)
                Button("No") { session.answerApproval(false) }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12))
    }

    /// A stop is a handover: the user acts in the same visible tab, then the
    /// run continues with whatever is left.
    private func handoverCard(_ handover: AgentSession.PendingHandover) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Over to you", systemImage: "hand.raised")
                .font(.headline)
            Text(handover.question).font(.body)
            TextField("What you did (optional)", text: $handoverNote)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Done — carry on") {
                    session.resolveHandover(resumed: true, note: handoverNote)
                    handoverNote = ""
                }
                .keyboardShortcut(.defaultAction)
                Button("Stop here") {
                    session.resolveHandover(resumed: false)
                    handoverNote = ""
                }
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.12))
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !session.plan.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Plan").font(.subheadline).bold()
                            ForEach(Array(session.plan.enumerated()), id: \.offset) { _, step in
                                Text("• \(step)").font(.caption)
                            }
                        }
                    }
                    ForEach(session.narration) { line in
                        Text(line.text)
                            .font(line.kind == .result ? .body : .caption)
                            .foregroundStyle(color(for: line.kind))
                            .id(line.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
            .onChange(of: session.narration.count) {
                if let last = session.narration.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private func color(for kind: AgentSession.NarrationLine.Kind) -> Color {
        switch kind {
        case .step: return .primary
        case .recovery: return .orange
        case .handover: return .accentColor
        case .result: return .primary
        }
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.status).font(.caption).lineLimit(2)
            Toggle("Trusted input (NSEvent)", isOn: $trustedInput)
                .font(.caption)
                .onChange(of: trustedInput) { _, enabled in session.useTrustedInput(enabled) }
            Text("Backend: \(session.backendName)")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }
}

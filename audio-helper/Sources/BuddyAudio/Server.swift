import Foundation
import Network

/// A WebSocket server on 127.0.0.1 only. One client at a time: a new
/// connection (the app reloading) replaces the old one.
final class WebSocketServer {
    private let listener: NWListener
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "buddy-audio.server")
    var onMessage: ((Data) -> Void)?
    var onConnect: (() -> Void)?

    init(port: UInt16) throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            self.connection?.cancel()
            self.connection = conn
            conn.stateUpdateHandler = { state in
                if case .ready = state { self.onConnect?() }
            }
            conn.start(queue: self.queue)
            self.receive(on: conn)
        }
        listener.stateUpdateHandler = { state in
            if case let .failed(error) = state {
                log("Listener failed: \(error). Is another buddy-audio running?")
                exit(1)
            }
        }
        listener.start(queue: queue)
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.onMessage?(data) }
            if error == nil, conn === self.connection { self.receive(on: conn) }
        }
    }

    func send(_ message: Outgoing) {
        guard let conn = connection else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "message", metadata: [meta])
        conn.send(content: message.json, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(("[buddy-audio] " + s + "\n").data(using: .utf8)!)
}

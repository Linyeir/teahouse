import type { WebSocket } from '@fastify/websocket';
import type { ServerEvent } from '@teahouse/shared';

/** All connected clients. Every client receives every event; there is only one user. */
export class Hub {
  readonly #sockets = new Map<WebSocket, string>();

  add(socket: WebSocket, deviceId: string): void {
    this.#sockets.set(socket, deviceId);
    socket.on('close', () => this.#sockets.delete(socket));
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const socket of this.#sockets.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  /** Closes the sockets of a signed-out device, which would otherwise keep receiving events. */
  disconnect(deviceId: string): void {
    for (const [socket, owner] of this.#sockets) {
      // 4401: application-defined "unauthorized", so the client does not reconnect blindly.
      if (owner === deviceId) socket.close(4401, 'Signed out');
    }
  }
}

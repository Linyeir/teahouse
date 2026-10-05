import type { WebSocket } from '@fastify/websocket';
import type { ServerEvent } from '@teahouse/shared';

/** All connected clients. Every client receives every event; there is only one user. */
export class Hub {
  readonly #sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const socket of this.#sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }
}

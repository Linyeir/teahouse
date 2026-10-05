import type { ClientEvent } from '@teahouse/shared';
import type { FastifyInstance } from 'fastify';
import type { Services } from './context.ts';

export async function wsRoutes(app: FastifyInstance, { hub, generator }: Services) {
  // Browsers cannot set headers on WebSocket requests, so the token comes as `?token=`.
  app.get('/api/ws', { websocket: true }, (socket) => {
    hub.add(socket);
    socket.on('message', (raw) => {
      let event: ClientEvent;
      try {
        event = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (event.type === 'generation.stop') generator.stop(event.messageId);
    });
  });
}

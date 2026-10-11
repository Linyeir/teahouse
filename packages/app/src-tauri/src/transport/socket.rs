//! The WebSocket through the app, for the same servers and with the same trust decision as
//! native_fetch. Frames reach the webview through a callback (a Tauri channel in the command);
//! sending and closing go through the socket's id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SocketEvent {
    Message {
        data: String,
    },
    /// The last event of a socket. 1006 when the connection broke without a close frame, as in
    /// browsers.
    Close {
        code: u16,
        reason: String,
    },
}

pub(super) enum Outgoing {
    Text(String),
    Close(u16, String),
}

/// The open sockets, by id.
#[derive(Default)]
pub struct Sockets {
    next: AtomicU32,
    open: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Outgoing>>>>,
}

impl Sockets {
    pub(super) fn send(&self, id: u32, message: Outgoing) -> Result<(), String> {
        let open = self.open.lock().map_err(|err| err.to_string())?;
        let socket = open.get(&id).ok_or("no such socket")?;
        socket
            .send(message)
            .map_err(|_| "the socket is closed".to_owned())
    }

    /// Runs a connected socket until either side closes it.
    pub(super) fn run<S>(&self, stream: S, on_event: impl Fn(SocketEvent) + Send + 'static) -> u32
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + futures_util::Sink<Message>
            + Unpin
            + Send
            + 'static,
    {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, mut outgoing) = mpsc::unbounded_channel();
        if let Ok(mut open) = self.open.lock() {
            open.insert(id, sender);
        }
        let open = self.open.clone();
        let (mut write, mut read) = stream.split();
        tauri::async_runtime::spawn(async move {
            let (code, reason) = loop {
                tokio::select! {
                    incoming = read.next() => match incoming {
                        Some(Ok(Message::Text(text))) => {
                            on_event(SocketEvent::Message { data: text.to_string() });
                        }
                        Some(Ok(Message::Close(frame))) => {
                            break frame
                                .map(|f| (u16::from(f.code), f.reason.to_string()))
                                .unwrap_or((1005, String::new()));
                        }
                        // tungstenite queues the pong; flushing sends it.
                        Some(Ok(Message::Ping(_))) => {
                            let _ = write.flush().await;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => break (1006, String::new()),
                    },
                    message = outgoing.recv() => match message {
                        Some(Outgoing::Text(text)) => {
                            if write.send(Message::text(text)).await.is_err() {
                                break (1006, String::new());
                            }
                        }
                        Some(Outgoing::Close(code, reason)) => {
                            let frame = CloseFrame {
                                code: CloseCode::from(code),
                                reason: reason.clone().into(),
                            };
                            let _ = write.send(Message::Close(Some(frame))).await;
                            break (code, reason);
                        }
                        None => break (1000, String::new()),
                    },
                }
            };
            let _ = write.close().await;
            if let Ok(mut open) = open.lock() {
                open.remove(&id);
            }
            on_event(SocketEvent::Close { code, reason });
        });
        id
    }
}

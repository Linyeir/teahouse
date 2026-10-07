import { z } from 'zod';

export const id = z.uuid();

export const credentialsInput = z.object({
  password: z.string().min(8).max(256),
  deviceName: z.string().min(1).max(100),
});
export type CredentialsInput = z.infer<typeof credentialsInput>;

export const authStatus = z.object({ passwordSet: z.boolean() });
export type AuthStatus = z.infer<typeof authStatus>;

export const tokenResponse = z.object({ token: z.string(), deviceId: id });
export type TokenResponse = z.infer<typeof tokenResponse>;

export const device = z.object({
  id,
  name: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof device>;

export const pairingCode = z.object({ code: z.string(), expiresAt: z.string() });
export type PairingCode = z.infer<typeof pairingCode>;

export const pairingClaimInput = z.object({
  code: z.string().min(1).max(64),
  deviceName: z.string().min(1).max(100),
});
export type PairingClaimInput = z.infer<typeof pairingClaimInput>;

/** Addresses under which other devices on the network may reach the server. */
export const serverAddresses = z.object({ addresses: z.array(z.string()) });
export type ServerAddresses = z.infer<typeof serverAddresses>;

export const samplingParams = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  maxTokens: z.number().int().positive().nullable(),
});

export const profileInput = samplingParams.extend({
  name: z.string().min(1).max(100),
  baseUrl: z.url(),
  /** Omitted on update keeps the stored key, an empty string clears it. */
  apiKey: z.string().max(1000).optional(),
  model: z.string().min(1).max(200),
  contextWindowOverride: z.number().int().positive().nullable(),
});
export type ProfileInput = z.infer<typeof profileInput>;

export const profile = profileInput.omit({ apiKey: true }).extend({
  id,
  hasApiKey: z.boolean(),
  detectedContextWindow: z.number().int().nullable(),
  updatedAt: z.string(),
});
export type Profile = z.infer<typeof profile>;

export const endpointProbeInput = z.object({
  baseUrl: z.url(),
  apiKey: z.string().max(1000).optional(),
  /** Reuse the key stored on this profile when apiKey is omitted. */
  profileId: id.optional(),
});
export type EndpointProbeInput = z.infer<typeof endpointProbeInput>;

export const modelList = z.object({ models: z.array(z.string()) });
export type ModelList = z.infer<typeof modelList>;

export const settings = z.object({
  userName: z.string().min(1).max(100),
  outputLanguage: z.string().min(1).max(50),
  /** Profiles per role. Null falls back to the narrator profile, then to the first profile. */
  narratorProfileId: id.nullable(),
  summaryProfileId: id.nullable(),
  canonProfileId: id.nullable(),
  sceneProfileId: id.nullable(),
  /** Review canon proposals as diffs before they are committed. */
  canonReview: z.boolean(),
});
export type Settings = z.infer<typeof settings>;

export const chatInput = z.object({
  worldId: id,
  characterSlug: z.string().min(1).max(200),
  /** Which of the character's greetings starts the chat. */
  greetingIndex: z.number().int().min(0).default(0),
  title: z.string().max(200).optional(),
});
export type ChatInput = z.infer<typeof chatInput>;

export const chat = z.object({
  id,
  title: z.string(),
  worldId: id,
  characterSlug: z.string(),
  activeLeafId: id.nullable(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chat>;

export const messageRole = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRole>;

export const messageStatus = z.enum(['complete', 'streaming', 'stopped', 'error']);
export type MessageStatus = z.infer<typeof messageStatus>;

export const message = z.object({
  id,
  chatId: id,
  parentId: id.nullable(),
  role: messageRole,
  content: z.string(),
  status: messageStatus,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Message = z.infer<typeof message>;

/** A message on the active path, with its position among its siblings. */
export const pathMessage = message.extend({
  siblingIds: z.array(id),
});
export type PathMessage = z.infer<typeof pathMessage>;

export const sceneStatus = z.enum(['active', 'closing', 'closed']);
export type SceneStatus = z.infer<typeof sceneStatus>;

export const scene = z.object({
  id,
  number: z.number().int(),
  status: sceneStatus,
  cast: z.array(z.string()),
  startMessageId: id.nullable(),
  canonCommit: z.string().nullable(),
});
export type Scene = z.infer<typeof scene>;

/** Active Memory: a summary of the scene up to and including `messageId`. */
export const memoryNode = z.object({
  id,
  messageId: id,
  content: z.string(),
  updatedAt: z.string(),
});
export type MemoryNode = z.infer<typeof memoryNode>;

export const closedScene = z.object({ scene, messages: z.array(pathMessage) });
export type ClosedScene = z.infer<typeof closedScene>;

export const chatPath = z.object({
  chat,
  /** The current scene: active, closing, or the last closed one. */
  scene: scene.nullable(),
  /** Active path of the current scene. */
  messages: z.array(pathMessage),
  /** Memory nodes on the active path, oldest first. */
  memory: z.array(memoryNode),
  closedScenes: z.array(closedScene),
});
export type ChatPath = z.infer<typeof chatPath>;

export const closeSceneInput = z.object({ withCanon: z.boolean() });
export type CloseSceneInput = z.infer<typeof closeSceneInput>;

export const sceneProposalInput = z.object({ brief: z.string().max(5000) });
export type SceneProposalInput = z.infer<typeof sceneProposalInput>;

export const sceneStartInput = z.object({
  startMessage: z.string().max(20_000),
  cast: z.array(z.string().min(1)).min(1),
});
export type SceneStartInput = z.infer<typeof sceneStartInput>;

export const proposalFile = z.object({
  path: z.string(),
  before: z.string().nullable(),
  after: z.string(),
  decision: z.enum(['pending', 'accepted', 'rejected']),
});
export type ProposalFileView = z.infer<typeof proposalFile>;

export const canonProposal = z.object({
  id,
  sceneId: id,
  status: z.enum(['generating', 'ready', 'failed', 'applied']),
  error: z.string().nullable(),
  files: z.array(proposalFile),
});
export type CanonProposal = z.infer<typeof canonProposal>;

export const proposalFileUpdate = z.object({
  path: z.string(),
  decision: z.enum(['pending', 'accepted', 'rejected']),
  after: z.string().max(1_000_000).optional(),
});
export type ProposalFileUpdate = z.infer<typeof proposalFileUpdate>;

export const sendMessageInput = z.object({
  /** Client-generated UUIDv7, so a retried request does not duplicate the message. */
  id: id.optional(),
  content: z.string().min(1).max(50_000),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const editMessageInput = z.object({ content: z.string().max(50_000) });
export type EditMessageInput = z.infer<typeof editMessageInput>;

export const selectLeafInput = z.object({ messageId: id });
export type SelectLeafInput = z.infer<typeof selectLeafInput>;

export const generationStarted = z.object({ messageId: id });
export type GenerationStarted = z.infer<typeof generationStarted>;

export const apiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof apiError>;

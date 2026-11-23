import type { DriverFeature } from '../turn-features';
import { createCapabilityFeature } from './capability';
import { createCleanupFeature } from './cleanup';
import { createContextFeature } from './context';
import { createFailureFeature } from './failure';
import { createHumanLikenessFeature } from './human-likeness';
import { createInterruptionFeature } from './interruption';
import { createLoggingFeature } from './logging';
import { createMailboxFeature } from './mailbox';
import { createNotesFeature } from './notes';
import { createPersistenceFeature } from './persistence';
import { createPromptFeature } from './prompt';
import { createReactionFeature } from './reaction';
import { createSendMessageFeature } from './send-message';
import { createSkillFeature } from './skill';
import { createToolFeature } from './tools';
import type { MainTurnFeatureDeps } from './types';

export const createMainTurnFeatures = (deps: MainTurnFeatureDeps): DriverFeature[] => [
  createContextFeature(deps),
  createInterruptionFeature(deps),
  createReactionFeature(deps),
  createCapabilityFeature(deps),
  createToolFeature(deps),
  createSkillFeature(deps),
  ...(deps.chatConfig.notes?.enabled ? [createNotesFeature(deps, deps.chatConfig.notes)] : []),
  createHumanLikenessFeature(deps),
  createPromptFeature(deps),
  createLoggingFeature(deps),
  createMailboxFeature(deps),
  createSendMessageFeature(),
  createPersistenceFeature(deps),
  createFailureFeature(deps),
  createCleanupFeature(deps),
];

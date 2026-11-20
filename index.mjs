import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import { createProviderConfig, PROVIDER_ID } from './lib/provider.mjs'

export default function (pi) {
  pi.registerProvider(PROVIDER_ID, createProviderConfig(openAICompletionsApi()))
}

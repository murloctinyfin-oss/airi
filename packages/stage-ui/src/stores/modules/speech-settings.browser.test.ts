import type { Pinia } from 'pinia'
import type { Component } from 'vue'

import type { KokoroAdapter } from '../../libs/inference/adapters/kokoro'
import type { Voices } from '../../workers/kokoro/types'

import en from '@proj-airi/i18n/locales/en'

import { MotionPlugin } from '@vueuse/motion'
import { createPinia, disposePinia, getActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import SpeechSettings from '../../../../stage-pages/src/pages/settings/modules/speech.vue'
import KokoroSettings from '../../../../stage-pages/src/pages/settings/providers/speech/kokoro-local.vue'

import { injectKeyPiniaSynced } from '../../libs/pinia/synced-context'
import { captureAnalyticsEvent, enableAnalyticsCapture, isAnalyticsAvailableInBuild } from '../../libs/product-signals/client'
import { useAuthStore } from '../auth'
import { useProviderConfigStore } from '../providers/config'
import { useProviderStore } from '../providers/provider'
import { useSpeechStore } from './speech'

// Analytics delivery is external IO. Exercise the real page and stores while
// recording its outgoing payload instead of sending product events.
vi.mock('../../libs/product-signals/client', { spy: true })

const kokoroVoices: Voices = { af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' } }

// Each Electron renderer owns one Kokoro adapter singleton, but test renderers
// share this module scope. Key the fake runtime by the Pinia that is active when
// `getKokoroAdapter()` runs. Pinia sets it when an action starts, so tests must
// not run Kokoro work in two renderers at once.
const kokoroRuntimes = new Map<Pinia, KokoroAdapter>()

function createKokoroRuntime(): KokoroAdapter {
  let loaded = false
  return {
    loadModel: vi.fn(async () => {
      loaded = true
      return kokoroVoices
    }),
    generate: vi.fn(async () => {
      if (!loaded)
        throw new Error('Model not loaded. Call loadModel() first.')
      return new ArrayBuffer(8)
    }),
    getVoices: () => {
      if (!loaded)
        throw new Error('Model not loaded. Call loadModel() first.')
      return kokoroVoices
    },
    terminate: vi.fn(),
    get state() { return loaded ? 'ready' : 'idle' },
    get manifest() { return loaded ? { quantization: 'fp32', device: 'wasm' } : null },
    deviceLossCount: 0,
  }
}

vi.mock('../../libs/inference/adapters/kokoro', () => ({
  getKokoroAdapter: async () => {
    const pinia = getActivePinia()
    if (!pinia)
      throw new Error('Kokoro adapter requested outside a renderer')
    let runtime = kokoroRuntimes.get(pinia)
    if (!runtime) {
      runtime = createKokoroRuntime()
      kokoroRuntimes.set(pinia, runtime)
    }
    return runtime
  },
}))

const cleanups: Array<() => void> = []

/** Mounts a real renderer with a separate Pinia and BroadcastChannel runtime. */
function mountRenderer(namespace: string, page?: Component) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ namespace, leadership: page ? 'follower-only' : 'leader-only' })
  pinia.use(runtime.plugin)
  const container = document.createElement('div')
  document.body.append(container)
  const app = createApp({
    setup() {
      useSpeechStore()
      return () => page ? h(page) : null
    },
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  app.provide(injectKeyPiniaSynced, runtime)
    .use(pinia)
    .use(router)
    .use(MotionPlugin)
    .use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
    .mount(container)
  cleanups.push(() => {
    app.unmount()
    disposePinia(pinia)
    runtime.dispose()
    container.remove()
  })
  return { app, pinia, runtime, container, speech: useSpeechStore(pinia) }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
  kokoroRuntimes.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

// https://github.com/moeru-ai/airi/actions/runs/34348745853/job/102456521103
// ROOT CAUSE: Page initialization and provider watchers awaited model RPCs
// without handling transport disposal. Passing assertions hid a teardown rejection.
it.each(['mount', 'provider change'])('handles interrupted model discovery after %s', async (trigger) => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], models: [], flux: 0 })))
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  await useProviderConfigStore(leader.pinia).ensureProvider('microsoft-speech', 'microsoft-speech', {
    apiKey: 'key',
    baseUrl: 'https://voices.invalid/v1/',
    region: 'eastasia',
  })
  await leader.speech.selectProviderModel('speech-noop', '')
  let completed = 0
  useProviderStore(leader.pinia).$onAction(({ name, after }) => {
    if (name === 'loadModelsForConfiguredProviders')
      after(() => completed++)
  })
  let blocked = 0
  let interrupt = trigger === 'mount'
  const postMessage = BroadcastChannel.prototype.postMessage
  vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: BroadcastChannel, message) {
    if (interrupt && JSON.stringify(message).includes('loadModelsForConfiguredProviders')) {
      blocked++
      return
    }
    postMessage.call(this, message)
  })
  const follower = mountRenderer(namespace, SpeechSettings)
  const globalErrors = vi.fn()
  follower.app.config.errorHandler = globalErrors
  if (trigger === 'provider change') {
    await vi.waitFor(() => expect(completed).toBeGreaterThan(0))
    interrupt = true
    await leader.speech.selectProviderModel('microsoft-speech', 'v1')
  }
  await vi.waitFor(() => expect(blocked).toBeGreaterThan(0))
  follower.runtime.dispose()
  await vi.waitFor(() => expect(globalErrors.mock.calls.length > 0 || follower.container.textContent?.includes('Pinia sync runtime was disposed before the RPC completed.')).toBe(true))
  expect(globalErrors).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(follower.container.textContent).toContain('Pinia sync runtime was disposed before the RPC completed.'))
})

// https://github.com/moeru-ai/airi/pull/2490#discussion_r3964866483
// ROOT CAUSE: The click handler read the old model before the leader RPC
// committed the provider. Analytics must use the completed selection receipt.
it('reports the committed provider and model after a settings-page click', async () => {
  localStorage.clear()
  vi.mocked(captureAnalyticsEvent).mockReset().mockReturnValue(true)
  vi.mocked(enableAnalyticsCapture).mockReturnValue(true)
  vi.mocked(isAnalyticsAvailableInBuild).mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], models: [], flux: 0 })))
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  await useProviderConfigStore(leader.pinia).ensureProvider('microsoft-speech', 'microsoft-speech', {
    apiKey: 'key',
    baseUrl: 'https://voices.invalid/v1/',
    region: 'eastasia',
  })
  await useProviderStore(leader.pinia).forceProviderConfigured('microsoft-speech')
  await leader.speech.selectProviderModel('speech-noop', 'previous-model')
  const follower = mountRenderer(namespace, SpeechSettings)
  await vi.waitFor(() => expect(follower.speech.activeSpeechModel).toBe('previous-model'))
  await vi.waitFor(() => expect(follower.container.querySelector('input[value="microsoft-speech"]')).not.toBeNull())
  const input = follower.container.querySelector<HTMLInputElement>('input[value="microsoft-speech"]')!
  input.click()
  await vi.waitFor(() => expect(vi.mocked(captureAnalyticsEvent).mock.calls.filter(([name]) => name === 'tts_provider_selected')).toHaveLength(1))
  expect(captureAnalyticsEvent).toHaveBeenCalledWith('tts_provider_selected', expect.objectContaining({
    tts_provider_id: 'microsoft-speech',
    tts_model_id: 'v1',
    source: 'settings',
  }))
  expect(follower.speech.activeSpeechProvider).toBe('microsoft-speech')
})

// https://github.com/moeru-ai/airi/pull/2490#discussion_r3967708960
// ROOT CAUSE: Manual input bypassed the guarded computed setter. A rejected
// leader RPC reached Vue's global handler instead of the page error display.
it('shows a manual model transport failure in the settings page', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], data: [] })))
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const provider = 'openai-compatible-audio-speech'
  await useProviderConfigStore(leader.pinia).ensureProvider(provider, provider, { apiKey: 'key', baseUrl: 'https://voices.invalid/v1/' })
  await useProviderStore(leader.pinia).forceProviderConfigured(provider)
  await leader.speech.selectProviderModel(provider, 'tts-1')
  const follower = mountRenderer(namespace, SpeechSettings)
  await vi.waitFor(() => expect(follower.container.querySelector('input[placeholder="tts-1"]')).not.toBeNull())
  await new Promise(resolve => setTimeout(resolve, 100))
  const globalErrors = vi.fn()
  follower.app.config.errorHandler = globalErrors
  const postMessage = BroadcastChannel.prototype.postMessage
  vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: BroadcastChannel, message) {
    if (JSON.stringify(message).includes('selectProviderModel'))
      throw new Error('Model selection transport unavailable')
    postMessage.call(this, message)
  })
  const input = follower.container.querySelector<HTMLInputElement>('input[placeholder="tts-1"]')!
  input.value = 'custom-model'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(globalErrors).not.toHaveBeenCalled()
  expect(follower.container.textContent).toContain('Model selection transport unavailable')
  expect(leader.speech.activeSpeechModel).toBe('tts-1')
})

// https://github.com/moeru-ai/airi/issues/2942
// ROOT CAUSE:
//
// The synced `loadProviderModel` loads Kokoro only in the leader. Test Voice ran
// in the settings renderer, whose adapter had no model:
//
// await generateSpeech({ ...provider.speech(model, config), input, voice })
//
// `generatePreviewSpeech` now sends a provider with `loadModel` to the leader.
it('issue #2942: plays a Kokoro test voice from the settings renderer after the stage renderer loads the model', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], models: [] })))
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const provider = 'kokoro-local'
  const config = { model: 'fp32', voiceId: '' }
  await useProviderConfigStore(leader.pinia).ensureProvider(provider, provider, config)
  await useProviderStore(leader.pinia).forceProviderConfigured(provider)
  // The stage renderer preloads the configured Kokoro model at startup.
  await useProviderStore(leader.pinia).loadProviderModel(provider, config)
  expect(kokoroRuntimes.get(leader.pinia)?.state).toBe('ready')
  await leader.speech.selectProviderModel(provider, 'fp32', 'af_heart')

  const follower = mountRenderer(namespace, SpeechSettings)
  await vi.waitFor(() => expect(follower.speech.activeSpeechVoice?.id).toBe('af_heart'))
  const testVoice = Array.from(follower.container.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === 'Test Voice')
  expect(testVoice).toBeDefined()
  await vi.waitFor(() => expect(testVoice!.disabled).toBe(false))
  testVoice!.click()

  const notLoaded = 'Model not loaded. Call loadModel() first.'
  await vi.waitFor(() => expect(follower.container.querySelector('audio') !== null || follower.container.textContent?.includes(notLoaded)).toBe(true))
  expect(follower.container.textContent).not.toContain(notLoaded)
  expect(follower.container.querySelector('audio')).not.toBeNull()
  expect(kokoroRuntimes.get(leader.pinia)?.generate).toHaveBeenCalledWith('Hello, my name is AI Assistant', 'af_heart')
  expect(kokoroRuntimes.has(follower.pinia)).toBe(false)
})

// https://github.com/moeru-ai/airi/issues/2942
it('issue #2942: plays the Kokoro playground voice from the settings renderer', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ voices: [], models: [] })))
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const provider = 'kokoro-local'
  await useProviderConfigStore(leader.pinia).ensureProvider(provider, provider, { model: 'fp32', voiceId: '' })
  await useProviderStore(leader.pinia).forceProviderConfigured(provider)

  // The page loads the model with the synced `loadProviderModel` when it mounts.
  const follower = mountRenderer(namespace, KokoroSettings)
  await vi.waitFor(() => expect(kokoroRuntimes.get(leader.pinia)?.state).toBe('ready'))
  const testVoice = () => Array.from(follower.container.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === 'Test Voice')
  await vi.waitFor(() => expect(testVoice()?.disabled).toBe(false))
  testVoice()!.click()

  const notLoaded = 'Model not loaded. Call loadModel() first.'
  await vi.waitFor(() => expect(follower.container.querySelector('audio') !== null || follower.container.textContent?.includes(notLoaded)).toBe(true))
  expect(follower.container.textContent).not.toContain(notLoaded)
  expect(follower.container.querySelector('audio')).not.toBeNull()
  expect(kokoroRuntimes.get(leader.pinia)?.generate).toHaveBeenCalledWith('Hello! This is a test of the Kokoro text-to-speech system.', 'af_heart')
  expect(kokoroRuntimes.has(follower.pinia)).toBe(false)
})

it('generates an official provider test voice with preview analytics in the settings renderer', async () => {
  localStorage.clear()
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes('/audio/speech'))
      return new Response(new ArrayBuffer(8))
    return Response.json({ voices: [{ id: 'voice', name: 'Voice', languages: [] }], models: [{ id: 'model-a', name: 'Model A' }], default: 'model-a' })
  })
  vi.stubGlobal('fetch', fetchMock)
  const namespace = `speech-settings:${crypto.randomUUID()}`
  const leader = mountRenderer(namespace)
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const now = new Date()
  useAuthStore(leader.pinia).$patch({
    token: 'access-token',
    user: { id: 'owner', name: 'Owner', email: 'owner@example.com', emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: 'session', userId: 'owner', token: 'session-token', createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 60000) },
  })
  const provider = 'official-provider-speech'
  await useProviderConfigStore(leader.pinia).ensureProvider(provider, provider, {})
  await useProviderStore(leader.pinia).forceProviderConfigured(provider)
  await leader.speech.selectProviderModel(provider, 'model-a', 'voice')
  const leaderActions: string[] = []
  leader.speech.$onAction(({ name }) => leaderActions.push(name))

  const follower = mountRenderer(namespace, SpeechSettings)
  await vi.waitFor(() => expect(follower.speech.activeSpeechVoice?.id).toBe('voice'))
  const testVoice = Array.from(follower.container.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === 'Test Voice')
  expect(testVoice).toBeDefined()
  await vi.waitFor(() => expect(testVoice!.disabled).toBe(false))
  testVoice!.click()

  await vi.waitFor(() => expect(follower.container.querySelector('audio')).not.toBeNull())
  const speechRequest = fetchMock.mock.calls.find(([input]) => String(input).includes('/audio/speech'))
  expect(speechRequest).toBeDefined()
  // The server reads preview analytics from `extra_body.airi_analytics`.
  expect(JSON.parse(String(speechRequest![1]?.body))).toMatchObject({ extra_body: { airi_analytics: { trigger: 'manual', source: 'manual_preview' } } })
  expect(leaderActions).not.toContain('generateSpeechInLeader')
})

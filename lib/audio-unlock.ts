// Hardware audio unlock for Smart TV browsers (Samsung Tizen / LG webOS) and
// other strict embedded WebKit/Chromium builds.
//
// Why this is needed:
// Smart TV browser engines enforce the autoplay policy far more aggressively
// than desktop Chrome/Firefox/Safari. A page may NOT start any audio
// (HTMLMediaElement OR Web Audio) until the user has interacted with it. In
// many TV builds the "gesture" that counts is narrower than on desktop — only
// a trusted click/keypress unlocks audio, and once an `await` runs the trusted
// gesture is consumed. Older WebKit TV engines also require an explicit
// `load()` token after the gesture to remap the decoded sound onto a hardware
// audio channel; calling `.play()` alone can silently no-op.
//
// This module bundles the three unlock actions a TV needs, and must be invoked
// synchronously from inside a single trusted user-interaction handler:
//   1. resume the Web Audio AudioContext (if suspended) — awaited
//   2. call .load() on the HTMLMediaElement to prime its hardware channel
//   3. call .play() — errors caught, never thrown into the UI

export type AudioUnlockOptions = {
  audioElement: HTMLAudioElement
  audioContext: AudioContext | null
  sourceUrl?: string
}

export type AudioUnlockResult = {
  contextResumed: boolean
  playbackStarted: boolean
}

/**
 * Prime and start audio on a TV browser inside an active user gesture.
 *
 * Call this from a click/keydown handler BEFORE any other async work. It is
 * intentionally synchronous in ordering: it kicks off the context resume and
 * immediately triggers a media load so both hardware channels are bound to the
 * trusted gesture.
 */
export async function unlockAndPlay({ audioElement, audioContext, sourceUrl }: AudioUnlockOptions): Promise<AudioUnlockResult> {
  const result: AudioUnlockResult = { contextResumed: false, playbackStarted: false }

  // 1) Resume the Web Audio context if the browser suspended it (autoplay
  //    policy). Awaiting here is safe because the caller invoked us from a
  //    trusted gesture — we just need the promise to resolve before playback.
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume()
      result.contextResumed = true
      console.log("[audio] AudioContext resumed inside user gesture; state =", audioContext.state)
    } catch (err) {
      console.error("[audio] AudioContext.resume() failed:", err)
    }
  }

  // 2) Explicitly load the media so old TV WebKit engines assign the decoded
  //    stream to a hardware audio channel. Without this some engines play
  //    silently.
  if (sourceUrl && audioElement.getAttribute("src") !== sourceUrl) {
    audioElement.setAttribute("src", sourceUrl)
  }
  try {
    audioElement.load()
  } catch (err) {
    console.error("[audio] audioElement.load() threw:", err)
  }

  // 3) Start playback. Errors are caught and logged, never propagated so the
  //    application UI is unaffected.
  try {
    await audioElement.play()
    result.playbackStarted = true
    console.log("[audio] audioElement.play() succeeded")
  } catch (err) {
    console.error("[audio] audioElement.play() rejected:", err)
  }

  return result
}

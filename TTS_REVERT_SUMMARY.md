# TTS Revert Complete: MP3 → speechSynthesis

## ✅ What Was Changed

### Removed (MP3 System)
- ❌ `scripts/generate-tts-audio.py` (deleted)
- ❌ `scripts/migration_recall_entry_payment.sql` (deleted — Entry/Payment recall still needs DB migration if not already applied)
- ❌ `public/audio/` directory (1600 MP3 files, ~109 MB deleted)
- ❌ `lib/audio-unlock.ts` (deleted)
- ❌ `vercel.json` audio MIME-type headers (removed)
- ❌ All `<audio>` element logic from `display-board.tsx` (removed)

### Added (speechSynthesis System)
- ✅ `speakAnnouncement(text: string)` function using `SpeechSynthesisUtterance`
- ✅ Tamil voice auto-selection: `voices.find(v => v.lang.startsWith('ta'))`
- ✅ Rate set to 0.85 for clarity
- ✅ Feature detection on mount + `voiceschanged` listener
- ✅ **Persistent warning banner** if no Tamil voice detected (amber background, AlertTriangle icon)

### Preserved (Working Systems)
- ✅ Global FIFO audio queue (`audioQueueRef`, `isPlayingRef`, `processQueue`)
- ✅ 12-item queue cap with overflow protection
- ✅ All 6 watchers: Dispatch (called_at), Entry number-change + recall (3 counters), Payment number-change + recall
- ✅ Synchronous ref updates before enqueue (race-condition fix)
- ✅ Chime + 450ms delay + speech pattern (timing unchanged)

## 📝 Tamil Announcement Phrases

| Counter | Phrase |
|---------|--------|
| **Dispatch** | `Token எண் {N}, தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்` |
| **Entry (1–4)** | `Token எண் {N}, பதிவு கவுண்டர் {C}-க்கு வரவும்` |
| **Payment** | `Token எண் {N}, தயவுசெய்து பணம் செலுத்தும் கவுண்டருக்கு வரவும்` |

*(Note: Entry phrase uses "பதிவு கவுண்டர்" = "registration counter", different from the old "நுழைவு கவுண்டர்" = "entry counter" used in the MP3 system)*

## 🔍 Verification Complete

- ✅ `npm run build` succeeded with no TypeScript errors
- ✅ Zero leftover references to `audio/ta`, `unlockAndPlay`, or `.mp3` files
- ✅ All imports resolved correctly

---

## ⚠️ CRITICAL: On-Device Testing Required

**The revert is complete, but speechSynthesis was previously confirmed non-functional on your deployment hardware.**

### Test Checklist

Run these tests **in order of importance**:

#### 1. 🔴 Fire TV Stick / Amazon Silk Browser (Production Hardware)
- [ ] Open `/display` page
- [ ] Press "Enable announcements"
- [ ] **Listen for chime** — should play immediately
- [ ] Trigger a Dispatch call from `/dispatch` page
- [ ] **Listen for Tamil speech** — confirm audible output
- [ ] Check browser console for `[tts] speaking: Token எண் ...` logs
- [ ] If **silent despite no errors**, speechSynthesis is still broken on Silk

#### 2. 🟡 Desktop Browser (Chrome/Firefox/Edge)
- [ ] Open `/display` page
- [ ] Check if yellow warning banner appears (if no Tamil voice installed)
- [ ] Press "Enable announcements"
- [ ] Trigger announcements for Dispatch, Entry (all 3 counters), Payment
- [ ] Confirm Tamil speech plays correctly with no overlap

#### 3. 🟢 Mobile Browser (Android Chrome/iOS Safari)
- [ ] Same tests as desktop
- [ ] Confirm speech works on mobile OS TTS engines

#### 4. ✅ "Call Again" Regression Check
- [ ] Press "Call Again" on Dispatch counter — should re-announce same token
- [ ] Press "Call Again" on Entry counter 1 — should re-announce same token
- [ ] Press "Call Again" on Payment counter — should re-announce same token
- [ ] Confirm no queue advancement, just re-announcement

#### 5. ✅ FIFO Queue Stress Test
- [ ] Rapidly trigger 4–5 announcements across different counters in <2 seconds
- [ ] Confirm they play sequentially (chime + speech) with no overlap
- [ ] Check console — queue should serialize all items, no AbortError

---

## 🚨 If Silk Still Produces No Audio

**Expected outcome based on prior testing:** Silk may accept `speechSynthesis.speak()` with zero JS errors but produce zero audio output.

### If this happens:

1. **Check the browser console logs** — look for:
   - `[tts] available voices: [...]` — does it list any Tamil voices?
   - `[tts] Tamil voice available: false` — warning banner should show
   - `[tts] speaking: Token எண் ...` — utterance was submitted
   - `[tts] utterance ended` — playback completed (but was it silent?)

2. **Open Silk's device settings** → Language & Input → Tamil. Confirm Tamil TTS engine is installed on the Fire Stick OS level (not just the browser).

3. **Test Google Translate** in Silk as a control — if Google Translate can speak Tamil but your app can't, there's a browser API integration issue.

4. **If confirmed broken after all checks:**
   - Do NOT ship this to production
   - Options:
     - Revert back to MP3 system (restore from git history)
     - Build a hybrid system (try TTS first, fall back to MP3 if silent for >2s)
     - Use a different display device that supports Tamil TTS

---

## 🔄 If You Need to Restore the MP3 System

```bash
# Check git history for the last commit before this revert
git log --oneline --all -- public/audio/

# Restore the deleted files
git checkout <commit-hash> -- public/audio/
git checkout <commit-hash> -- scripts/generate-tts-audio.py
git checkout <commit-hash> -- lib/audio-unlock.ts
git checkout <commit-hash> -- components/display/display-board.tsx
git checkout <commit-hash> -- vercel.json

# Rebuild
npm run build
```

---

## 📊 File Size Impact

**Before (MP3):**
- `public/audio/ta/`: 109 MB (1600 files)
- Deployed bundle size: larger, but files served via CDN

**After (TTS):**
- `public/audio/ta/`: deleted
- Deployed bundle size: smaller (no static audio assets)
- Runtime: depends on device's OS TTS engine (quality varies)

---

## ✍️ Notes for Future

- The MP3 system was built as a **workaround for confirmed platform limitations**, not a design preference.
- If TTS works now, great — the code is cleaner and the bundle is smaller.
- If TTS still fails on Silk, **this revert was premature** and production will be silent.
- Always test on actual deployment hardware before removing working workarounds.

---

**Status:** Code complete, build verified, awaiting on-device confirmation. 🎯

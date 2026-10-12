import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateWordTimings } from '@shared/captions'
import { stripVoiceTags } from '@shared/speech'
import { getStyle } from '@shared/styles'
import type { AspectRatio, Character, Clip, CreditEstimate, Job, Project, WordTiming } from '@shared/types'
import { emit } from './events'
import { runJob } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateAssetMeta,
  updateJob
} from './repo'
import { getSettings } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as huggingface from './services/huggingface'

function extFromType(contentType: string, url: string, fallback: string): string {
  if (/png/.test(contentType)) return '.png'
  if (/jpe?g/.test(contentType)) return '.jpg'
  if (/webp/.test(contentType)) return '.webp'
  if (/mp4/.test(contentType)) return '.mp4'
  const m = /\.(png|jpe?g|webp|mp4|mov)(\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : fallback
}

// ---------- prompts ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * The image prompt for a clip. The scene comes first so the model gets the content right, then who the
 * characters are, then the art style. Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number): string {
  const style = getStyle(project.styleId)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.push(
      `Reference images are character sheets, in this order: ${refNames.join(', ')}. Use them for each character's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  parts.push(`Art style: ${style.prompt}`)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId)
  return [
    style.prompt,
    `Character reference sheet for "${c.name}": ${c.description}. The character is ${style.characterHint}.`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.'
  ].join('\n\n')
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

function finishImageAsset(
  job: Job,
  target: 'clip-image' | 'sheet',
  model: string,
  prompt: string,
  provider: string,
  bytes: Buffer,
  contentType: string
): string {
  const rel = saveFile(job.projectId, 'images', extFromType(contentType, '', '.png'), bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const asset = insertAsset({
    projectId: job.projectId,
    clipId: job.clipId,
    characterId: job.characterId,
    kind: 'image',
    provider,
    model,
    prompt,
    remoteId: null,
    remoteUrl: null,
    localPath: rel,
    durationMs: null,
    width: null,
    height: null
  })
  probeSize(abs).then((size) => {
    if (size) updateAssetMeta(asset.id, { ...asset.meta, width: size.width, height: size.height })
  }).catch(() => {})
  emit.asset(asset)
  if (target === 'sheet' && job.characterId) {
    setCharacterSheet(job.characterId, asset.id)
    emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
  } else if (target === 'clip-image' && job.clipId) {
    patchClip(job.clipId, { imageAssetId: asset.id })
    emit.clip({ clipId: job.clipId, patch: { imageAssetId: asset.id } })
    const project = getProject(job.projectId)
    const first = clipsOf(job.projectId)[0]
    if (!project.coverAssetId || first?.id === job.clipId) touchProject(job.projectId, { coverAssetId: asset.id })
  }
  touchProject(job.projectId)
  return asset.id
}

// ---------- public entry points ----------

export function generateClipImage(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  const settings = getSettings()

  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider: 'huggingface' })
  emit.job(job)
  return runJob(job, 'huggingface', async (ctx) => {
    ctx.progress(0.1, 'Menyiapkan prompt gambar')
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const prompt = clipPrompt(project, fresh, chars, [], 1000)
    const model = settings.hfImageModel || huggingface.HF_DEFAULT_IMAGE_MODEL
    ctx.progress(0.3, `Mengirim ke Hugging Face (${model.split('/').pop()})`)
    const { bytes, contentType } = await huggingface.generateImage(prompt, {
      model,
      signal: ctx.signal
    })
    ctx.progress(0.9, 'Menyimpan aset gambar')
    return finishImageAsset(job, 'clip-image', model, prompt, 'huggingface', bytes, contentType)
  })
}

export function generateCharacterSheet(characterId: string): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  const settings = getSettings()

  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider: 'huggingface' })
  emit.job(job)
  return runJob(job, 'huggingface', async (ctx) => {
    ctx.progress(0.1, 'Menyiapkan prompt lembar karakter')
    const project = getProject(c.projectId)
    const prompt = sheetPrompt(project, getCharacter(characterId))
    const model = settings.hfImageModel || huggingface.HF_DEFAULT_IMAGE_MODEL
    ctx.progress(0.3, `Mengirim ke Hugging Face (${model.split('/').pop()})`)
    const { bytes, contentType } = await huggingface.generateImage(prompt, {
      model,
      signal: ctx.signal
    })
    ctx.progress(0.9, 'Menyimpan lembar karakter')
    return finishImageAsset(job, 'sheet', model, prompt, 'huggingface', bytes, contentType)
  })
}

export function generateClipVideo(_clipId: string): Job {
  throw new Error('Generasi video AI tidak tersedia. Gunakan fitur Gerak Kamera untuk menganimasikan klip.')
}

export function generateClipTts(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider: project.ttsProvider })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const fresh = getClip(clipId)
    const p = getProject(fresh.projectId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    ctx.progress(0.2, 'Membuat suara')
    let rel: string
    let words: WordTiming[] | undefined
    let estimated = false
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : '')
    if (p.ttsProvider === 'elevenlabs') {
      if (!voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
      const out = await eleven.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.mp3', out.audio)
      words = out.words
    } else {
      const wav = await gemini.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', wav)
    }
    ctx.progress(0.85, 'Mengukur durasi')
    const audioMs = await probeDurationMs(assetAbsPath(p.id, rel))
    if (!words?.length) {
      words = estimateWordTimings(stripVoiceTags(text), audioMs / 1000)
      estimated = true
    }
    const asset = insertAsset({
      projectId: p.id,
      clipId,
      kind: 'audio',
      provider: p.ttsProvider,
      model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : getSettings().elevenModel,
      prompt: text,
      localPath: rel,
      durationMs: audioMs,
      meta: { words, estimatedTimings: estimated, voice }
    })
    emit.asset(asset)
    const durationMs = Math.max(1500, audioMs + 400)
    const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
    patchClip(clipId, patch)
    emit.clip({ clipId, patch })
    touchProject(p.id)
    return asset.id
  })
}

export function generateMissingImages(projectId: string): Job[] {
  const jobs: Job[] = []
  const needed = new Set(clipsOf(projectId).flatMap((c) => c.characterIds))
  for (const c of charactersOf(projectId)) {
    if (needed.has(c.id) && !c.sheetAssetId) jobs.push(generateCharacterSheet(c.id))
  }
  for (const clip of clipsOf(projectId)) {
    if (!clip.imageAssetId) jobs.push(generateClipImage(clip.id))
  }
  return jobs
}

/** Turns every clip that has an image but no AI video yet into a video. */
export function generateMissingVideos(projectId: string): Job[] {
  const clips = clipsOf(projectId)
  if (clips.some((c) => !c.imageAssetId)) throw new Error('Buat gambar semua klip dulu sebelum menjadikannya video.')
  return clips.filter((c) => !c.videoAssetId).map((c) => generateClipVideo(c.id))
}

export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId && c.narration.trim())
    .map((c) => generateClipTts(c.id))
}

/** After a restart, mark any unfinished jobs as failed. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    emit.job(updateJob(row.id, { status: 'failed', error: 'Terhenti karena aplikasi ditutup. Coba lagi.', message: null }))
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  if (!asset || asset.clipId !== clipId) throw new Error('Aset tidak cocok dengan klip ini')
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0 }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}

/** Free serverless models do not consume credits. */
export async function estimateCredits(
  _kind: 'image' | 'video',
  _modelId: string,
  _aspect: AspectRatio,
  _seconds = 5,
  _resolution?: string | null
): Promise<CreditEstimate | null> {
  return null
}

export function forgetEstimates(): void {
  // No-op
}

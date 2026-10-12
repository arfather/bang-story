import { Client } from '@gradio/client'
import type { KeyTestResult } from '@shared/types'
import { getSecret, requireSecret } from '../secrets'
import { ApiError } from './http'

export { HF_DEFAULT_IMAGE_MODEL, HF_IMAGE_MODELS } from '@shared/huggingface'

const SPACE_ID = 'Viggle/Qwen-Image-2.1-viggle-turbo'

export interface HfImageOptions {
  model?: string
  width?: number
  height?: number
  cred?: string
  signal?: AbortSignal
}

/**
 * Maps width and height to one of the presets supported by the Qwen Turbo Space,
 * or defaults to 16:9 / 1:1 if needed.
 */
function resolveSizeLabel(width?: number, height?: number): { size_label: string; w: number; h: number } {
  const w = width || 1280
  const h = height || 720
  const aspect = w / h

  if (aspect > 1.5) {
    return { size_label: '16:9 · 1280×720 (1024² area)', w: 1280, h: 720 }
  }
  if (aspect < 0.7) {
    return { size_label: '9:16 · 720×1280 (1024² area)', w: 720, h: 1280 }
  }
  return { size_label: '1:1 · 1024×1024 (1024² area)', w: 1024, h: 1024 }
}

/**
 * Generates an image via Hugging Face Space (Viggle/Qwen-Image-2.1-viggle-turbo).
 * Connects via @gradio/client with the user token and retrieves the rendered image.
 */
export async function generateImage(
  prompt: string,
  options: HfImageOptions = {}
): Promise<{ bytes: Buffer; contentType: string }> {
  const token = (options.cred ?? requireSecret('huggingface')).trim()
  if (options.signal?.aborted) throw new Error('Dibatalkan')

  const { size_label, w, h } = resolveSizeLabel(options.width, options.height)

  let client: any = null
  try {
    client = await Client.connect(SPACE_ID, {
      token: token as `hf_${string}`
    })

    if (options.signal?.aborted) {
      client.close?.()
      throw new Error('Dibatalkan')
    }

    const abortHandler = () => {
      try {
        client?.close?.()
      } catch {
        // ignore
      }
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })

    const result = (await client.predict('/generate', {
      prompt,
      refs: [],
      size_label,
      seed: Math.floor(Math.random() * 2147483647),
      randomize_seed: true,
      enhance: 'Auto',
      steps: 3,
      custom_width: w,
      custom_height: h,
      version: 'v0.3'
    })) as { data?: unknown[] }

    options.signal?.removeEventListener('abort', abortHandler)

    // Gradio keeps connection alive, so close immediately to release sockets
    client.close?.()

    const fileObj = (result.data?.[0] as { url?: string } | undefined)
    if (!fileObj?.url) {
      throw new Error('Gagal menerima URL gambar dari Hugging Face Space.')
    }

    const imgRes = await fetch(fileObj.url, { signal: options.signal })
    if (!imgRes.ok) {
      throw new Error(`Gagal mengunduh gambar yang dihasilkan (HTTP ${imgRes.status})`)
    }

    const contentType = imgRes.headers.get('content-type') || 'image/png'
    const arrayBuffer = await imgRes.arrayBuffer()
    return { bytes: Buffer.from(arrayBuffer), contentType }
  } catch (err) {
    if (client) {
      try {
        client.close?.()
      } catch {
        // ignore
      }
    }

    if (options.signal?.aborted) throw new Error('Dibatalkan')

    const message = (err as Error).message || String(err)
    if (/unauthorized|401/i.test(message)) {
      throw new ApiError(
        'Token Hugging Face tidak valid. Buat Access Token di huggingface.co/settings/tokens lalu simpan di Pengaturan.',
        401
      )
    }
    if (/forbidden|403/i.test(message)) {
      throw new ApiError('Akses ke Space ditolak oleh Hugging Face. Periksa izin token kamu.', 403)
    }
    if (/rate limit|429/i.test(message)) {
      throw new ApiError('Batas laju permintaan (rate limit) Hugging Face tercapai. Tunggu beberapa saat.', 429, true)
    }

    throw new Error(`Gagal membuat gambar via Hugging Face Space: ${message}`)
  }
}

/** Validates the Hugging Face User Access Token via whoami API. */
export async function testCredentials(cred?: string): Promise<KeyTestResult> {
  const token = cred ?? getSecret('huggingface')
  if (!token) return { ok: false, message: 'Token belum diatur' }

  try {
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: {
        Authorization: `Bearer ${token.trim()}`
      }
    })

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, message: 'Token ditolak. Pastikan token berawalan hf_ dan aktif.' }
      }
      return { ok: false, message: `Gagal verifikasi token (HTTP ${res.status})` }
    }

    const data = (await res.json()) as { name?: string; type?: string }
    const username = data.name ? `@${data.name}` : 'Akun terverifikasi'
    return { ok: true, message: `Terhubung sebagai ${username} (Qwen Turbo Space)` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

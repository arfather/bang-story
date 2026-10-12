export interface HuggingFaceModel {
  id: string
  name: string
  description: string
  family: string
  badge?: string
}

export const HF_DEFAULT_IMAGE_MODEL = 'Viggle/Qwen-Image-2.1-viggle-turbo'

export const HF_IMAGE_MODELS: HuggingFaceModel[] = [
  {
    id: 'Viggle/Qwen-Image-2.1-viggle-turbo',
    name: 'Qwen-Image 2.1 Viggle Turbo',
    description: 'Generasi gambar super cepat (1-2 detik) via Hugging Face Space dengan kualitas sinematik tinggi.',
    family: 'Qwen',
    badge: 'Turbo Gratis'
  }
]

export function getHfImageModel(id?: string | null): HuggingFaceModel {
  return HF_IMAGE_MODELS.find((m) => m.id === id) ?? HF_IMAGE_MODELS[0]
}

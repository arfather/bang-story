import { useEffect, useState, type ReactNode } from 'react'
import { Image as ImageIcon, Sparkles, Check } from 'lucide-react'
import { HF_IMAGE_MODELS, getHfImageModel } from '@shared/huggingface'
import type { Project } from '@shared/types'
import { Select } from '../../components/Select'

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line-2 bg-surface p-4">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        {icon}
        {title}
      </span>
      {children}
    </div>
  )
}

/** Which Hugging Face model generates this project's images. */
export function ModelSection({
  project,
  clipCount,
  onChange
}: {
  project: Project
  clipCount: number
  perClip: number
  onChange: (patch: { imageModel?: string }) => void
}) {
  const currentModel = getHfImageModel(project.imageModel)
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  useEffect(() => {
    void window.api.settings.keys().then((keys) => setHasKey(!!keys.find((k) => k.provider === 'huggingface')?.configured))
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">Model Gambar AI (Hugging Face)</span>
        <span className="text-[13px] text-muted">
          Serverless inference gratis untuk storyboard
        </span>
      </div>
      <Card icon={<ImageIcon className="size-4" />} title="Model Generasi Gambar">
        <div className="flex flex-col gap-2.5">
          <Select
            label="Model gambar Hugging Face"
            value={currentModel.id}
            onChange={(id) => onChange({ imageModel: id })}
            options={HF_IMAGE_MODELS.map((m) => ({
              value: m.id,
              label: m.name,
              hint: m.badge,
              note: m.description
            }))}
          />
          <div className="flex items-center justify-between text-[12.5px] text-ink-2">
            <span className="flex items-center gap-1.5 text-accent-dark font-medium">
              <Sparkles className="size-3.5 text-accent" />
              100% Gratis Serverless · {clipCount} gambar
            </span>
            {hasKey ? (
              <span className="flex items-center gap-1 text-xs text-ok-ink">
                <Check className="size-3" /> Token aktif
              </span>
            ) : (
              <span className="text-xs text-muted">Token Hugging Face diatur di Pengaturan</span>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

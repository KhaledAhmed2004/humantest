import { useState } from 'react'
import { CheckIcon, FilePlus2Icon, LoaderCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { saveDraft } from '@/lib/api'
import { friendlyProblem } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Saves a draft test that checks one rule as a new .ht file, then says where it is. */
export function DraftButton({ project, draft, label = 'Make a draft test', className }: { project?: string | null; draft: string; label?: string; className?: string }) {
  const [state, setState] = useState<{ busy?: boolean; file?: string }>({})
  const make = async () => {
    if (!project) return
    setState({ busy: true })
    let r: Awaited<ReturnType<typeof saveDraft>>
    try { r = await saveDraft(project, draft) } catch (e) { r = { error: String(e) } }
    if (r.error || !r.file) {
      setState({})
      toast.error('Could not save the draft.', { description: r.error })
      return
    }
    setState({ file: r.file })
    const problems = r.diagnostics ?? []
    toast.success(`Saved as ${r.file}`, {
      description: problems.length
        ? `It needs fixing before it can run: ${friendlyProblem(problems[0])}`
        : 'It is listed with your tests but not run while it says "Draft:". Change its steps, then change "Draft:" to "Test:".',
      ...(r.path ? { action: { label: 'Open in VS Code', onClick: () => { window.location.href = `vscode://file/${r.path!.replace(/\\/g, '/')}` } } } : {}),
    })
  }
  if (state.file) {
    return <p className={cn('flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400', className)}><CheckIcon className="size-3.5" /> Draft saved as <span className="font-mono">{state.file}</span></p>
  }
  return (
    <Button size="sm" variant="outline" className={className} disabled={state.busy || !project} onClick={make}>
      {state.busy ? <LoaderCircleIcon className="animate-spin" /> : <FilePlus2Icon />} {label}
    </Button>
  )
}

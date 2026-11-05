import { useState } from 'react'
import { ChevronUpIcon, ListChecksIcon, TerminalIcon } from 'lucide-react'
import { AppHeader } from '@/components/app-header'
import { TestDetail } from '@/components/test-detail'
import { TestList } from '@/components/test-list'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { storage } from '@/lib/format'
import { useHumanTest } from '@/lib/use-humantest'

export default function App() {
  const ht = useHumanTest()
  const [chosen, setChosen] = useState<string | null>(storage.get('ht.selected'))
  const [demo, setDemo] = useState(storage.get('ht.demo') === '1')
  const [outputOpen, setOutputOpen] = useState(false)

  // The chosen test, or the first one when it isn't in this project.
  const test = ht.tests.find((t) => t.key === chosen) ?? ht.tests[0]
  const selected = test?.key ?? null

  const select = (key: string) => { setChosen(key); storage.set('ht.selected', key) }
  const changeDemo = (on: boolean) => { setDemo(on); storage.set('ht.demo', on ? '1' : '0') }

  return (
    <div className="flex h-dvh flex-col bg-muted/30">
      <AppHeader ht={ht} demo={demo} onDemoChange={changeDemo} />

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="30" minSize="18" maxSize="50">
          <TestList ht={ht} selected={selected} onSelect={select} demo={demo} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="70">
          <main className="h-full overflow-auto">
            {test ? <TestDetail ht={ht} test={test} /> : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><ListChecksIcon /></EmptyMedia>
                  <EmptyTitle>{ht.tests.length ? 'Pick a test' : 'No tests yet'}</EmptyTitle>
                  <EmptyDescription>
                    {ht.tests.length ? 'Choose a test on the left to see its steps, results and replay.' : 'Add a .ht file to the tests folder of this project.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Collapsible open={outputOpen} onOpenChange={setOutputOpen} className="border-t bg-background">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
          <TerminalIcon className="size-4" /> Output
          {ht.logs.length > 0 && <span className="text-xs">({ht.logs.length} lines)</span>}
          <ChevronUpIcon className={`ml-auto size-4 transition-transform ${outputOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="max-h-60 overflow-auto px-4 pb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {ht.logs.length ? ht.logs.join('\n') : 'Nothing yet. Playwright\'s output shows up here while tests run.'}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

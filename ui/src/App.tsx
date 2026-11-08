import { useState } from 'react'
import { ChevronUpIcon, ListChecksIcon, TerminalIcon } from 'lucide-react'
import { AppHeader, type View } from '@/components/app-header'
import { Coverage } from '@/components/coverage'
import { Features } from '@/components/features'
import { TestDetail } from '@/components/test-detail'
import { TestList } from '@/components/test-list'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { storage } from '@/lib/format'
import { useHumanTest } from '@/lib/use-humantest'
import { useMediaQuery } from '@/lib/use-media-query'

export default function App() {
  const ht = useHumanTest()
  const [chosen, setChosen] = useState<string | null>(storage.get('ht.selected'))
  const [demo, setDemo] = useState(storage.get('ht.demo') === '1')
  const [outputOpen, setOutputOpen] = useState(false)
  const [view, setView] = useState<View>(() => { const v = storage.get('ht.view'); return v === 'coverage' || v === 'logic' ? v : 'tests' })
  const changeView = (v: View) => { setView(v); storage.set('ht.view', v) }
  const narrow = useMediaQuery('(max-width: 767px)')

  // The chosen test, or the first one when it isn't in this project.
  const test = ht.tests.find((t) => t.key === chosen) ?? ht.tests[0]
  const selected = test?.key ?? null

  const select = (key: string) => { setChosen(key); storage.set('ht.selected', key) }
  const changeDemo = (on: boolean) => { setDemo(on); storage.set('ht.demo', on ? '1' : '0') }

  return (
    <div className="flex h-dvh flex-col bg-muted/30">
      <AppHeader ht={ht} demo={demo} onDemoChange={changeDemo} view={view} onViewChange={changeView} />

      {/* Coverage, or the tests: side by side on wide screens; on phones the list sits on top of the details. */}
      {view === 'logic' ? (
        <main className="min-h-0 flex-1 overflow-y-auto"><Features ht={ht} /></main>
      ) : view === 'coverage' ? (
        // A plain scroller: ScrollArea's content grows to the table's width, which clips text on phones.
        <main className="min-h-0 flex-1 overflow-y-auto"><Coverage ht={ht} /></main>
      ) : (
      <ResizablePanelGroup key={narrow ? 'stacked' : 'side'} orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
        <ResizablePanel defaultSize={narrow ? '40' : '30'} minSize={narrow ? '20' : '18'} maxSize={narrow ? '75' : '50'}>
          <TestList ht={ht} selected={selected} onSelect={select} demo={demo} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={narrow ? '60' : '70'}>
          {/* shadcn ScrollArea instead of the browser's own scrollbar. */}
          <ScrollArea className="h-full">
          <main>
            {test ? <TestDetail ht={ht} test={test} demo={demo} /> : (
              <Empty className="min-h-[70vh]">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><ListChecksIcon /></EmptyMedia>
                  <EmptyTitle>{ht.tests.length ? 'Pick a test' : 'No tests yet'}</EmptyTitle>
                  <EmptyDescription>
                    {ht.tests.length ? 'Choose a test on the left to see its steps, results and video.' : 'Write a test in this project’s tests folder and it shows up here.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </main>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
      )}

      <Collapsible open={outputOpen} onOpenChange={setOutputOpen} className="border-t bg-background">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
          <TerminalIcon className="size-4" /> Developer log
          {ht.logs.length > 0 && <span className="text-xs">({ht.logs.length} lines)</span>}
          <ChevronUpIcon className={`ml-auto size-4 transition-transform ${outputOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="h-60">
            <pre className="px-4 pb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {ht.logs.length ? ht.logs.join('\n') : 'Nothing yet. Messages from the test run show up here.'}
            </pre>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

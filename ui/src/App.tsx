import { useEffect, useState } from 'react'
import { ChevronUpIcon, ListChecksIcon, PanelLeftOpenIcon, TerminalIcon, TriangleAlertIcon } from 'lucide-react'
import { usePanelRef } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  const [outputOpen, setOutputOpen] = useState(false)
  // When a run stops before any test ran, the log is the only place that says why: open it.
  const [seenStartFailed, setSeenStartFailed] = useState(false)
  if (ht.startFailed !== seenStartFailed) {
    setSeenStartFailed(ht.startFailed)
    if (ht.startFailed) setOutputOpen(true)
  }
  const [view, setView] = useState<View>(() => { const v = storage.get('ht.view'); return v === 'coverage' || v === 'logic' ? v : 'tests' })
  const changeView = (v: View) => { setView(v); storage.set('ht.view', v) }
  const narrow = useMediaQuery('(max-width: 767px)')

  // The chosen test, or the first one when it isn't in this project.
  const test = ht.tests.find((t) => t.key === chosen) ?? ht.tests[0]
  const selected = test?.key ?? null

  const select = (key: string) => { setChosen(key); storage.set('ht.selected', key) }

  // The test list can be hidden to give the test more room: the button, Ctrl+B, or dragging its edge all the way left.
  const listPanel = usePanelRef()
  const [listHidden, setListHidden] = useState(() => storage.get('ht.listHidden') === '1')
  const canHideList = !narrow && view === 'tests'
  const toggleList = () => {
    const p = listPanel.current
    if (!p) return
    if (!p.isCollapsed()) { p.collapse(); return }
    p.expand()
    // Opened after a reload, it has no earlier width to return to and would come back at its narrowest.
    if (p.getSize().asPercentage < 25) p.resize('30%')
  }
  useEffect(() => {
    if (!canHideList) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleList() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex h-dvh flex-col bg-muted/30">
      <AppHeader ht={ht} view={view} onViewChange={changeView} />

      {ht.startFailed && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <TriangleAlertIcon />
          <AlertTitle>The tests couldn't start</AlertTitle>
          <AlertDescription>
            <p>
              The run stopped before any test ran, so there are no steps to show. The developer log below says why.
              {!outputOpen && <> <button type="button" className="font-medium underline underline-offset-2" onClick={() => setOutputOpen(true)}>Show the log</button></>}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Coverage, or the tests: side by side on wide screens; on phones the list sits on top of the details. */}
      {view === 'logic' ? (
        <main className="min-h-0 flex-1 overflow-y-auto"><Features ht={ht} /></main>
      ) : view === 'coverage' ? (
        // A plain scroller: ScrollArea's content grows to the table's width, which clips text on phones.
        <main className="min-h-0 flex-1 overflow-y-auto"><Coverage ht={ht} /></main>
      ) : (
      <ResizablePanelGroup key={narrow ? 'stacked' : 'side'} orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
        <ResizablePanel
          panelRef={listPanel}
          defaultSize={narrow ? '40' : listHidden ? '0' : '30'} minSize={narrow ? '20' : '18'} maxSize={narrow ? '75' : '50'}
          collapsible={!narrow} collapsedSize="0"
          onResize={() => {
            const hidden = !narrow && !!listPanel.current?.isCollapsed()
            if (hidden !== listHidden) { setListHidden(hidden); storage.set('ht.listHidden', hidden ? '1' : '0') }
          }}
        >
          <TestList ht={ht} selected={selected} onSelect={select} onCollapse={narrow ? undefined : toggleList} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={narrow ? '60' : '70'} className="relative">
          {canHideList && listHidden && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="absolute top-3 left-3 z-20 gap-1.5 bg-background/90 shadow-sm backdrop-blur" aria-label="Show the test list" onClick={toggleList}>
                  <PanelLeftOpenIcon /> Tests
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Show the list <kbd className="ml-1 opacity-70">Ctrl B</kbd></TooltipContent>
            </Tooltip>
          )}
          {/* shadcn ScrollArea instead of the browser's own scrollbar. */}
          <ScrollArea className="h-full">
          <main>
            {test ? <TestDetail ht={ht} test={test} roomy={canHideList && listHidden} /> : (
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

      {/* Raw output of the run, for when something breaks outside a test. Hidden while there's none. */}
      {ht.logs.length > 0 && (
        <Collapsible open={outputOpen} onOpenChange={setOutputOpen} className="border-t bg-background">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            <TerminalIcon className="size-3.5" /> Developer log
            <span>({ht.logs.length} {ht.logs.length === 1 ? 'line' : 'lines'})</span>
            <ChevronUpIcon className={`ml-auto size-4 transition-transform ${outputOpen ? 'rotate-180' : ''}`} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="h-60">
              <pre className="px-4 pb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{ht.logs.join('\n')}</pre>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

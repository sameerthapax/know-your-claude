import { expect, mock, test } from 'claude-code/testing'

const QUIZ = {
  questions: ['easy', 'easy', 'medium', 'medium', 'hard'].map((difficulty, n) => ({
    difficulty,
    question: 'Question ' + (n + 1) + '?',
    choices: ['first', 'second', 'third', 'fourth'],
    answer: 1,
    why: 'Because the second one is right.',
  })),
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PANE = {
  plugin: 'brain-bar',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'brain-test',
  props: { title: 'Brain test', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

function world(on: any, hp: number, model: () => unknown) {
  const opened: string[] = []
  mock.store(on, { 'hp:/repo': hp })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('audio.play', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('model.complete', model)
  return opened
}

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

test('loading fills the pane with the Claude and brain picture', async ($, on) => {
  const clock = mock.clock(on)
  let release: (v: unknown) => void = () => {}
  world(on, 9000, () => new Promise((r) => (release = r)))
  await $.session.start({ cwd: '/repo' })
  await $.command.run({ command: 'brain-test', args: '' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'loading' })).toBeDefined()
  expect(await texts(ui)).toContain('BRAIN TEST')
  // Let the test end: the writer gives up, so the quiz closes itself
  release({ value: { isAnswered: false, reason: 'aborted', usage: USAGE } })
  await clock.advance(100)
})

test('a wrong answer shows its result, and five answers reach the final screen', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, () => ({ value: { isAnswered: true, text: JSON.stringify(QUIZ), usage: USAGE } }))
  await $.session.start({ cwd: '/repo' })
  await $.command.run({ command: 'brain-test', args: '' })
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'ans-0' })
  await clock.advance(1500)
  expect(await texts(ui)).toContain('WRONG')

  await clock.advance(4000)
  for (let i = 1; i < 5; i++) {
    await ui.press({ key: 'ans-1' })
    await clock.advance(2100)
  }
  await clock.advance(1500)
  const done = await texts(ui)
  expect(done).toContain('4 / 5 CORRECT')
  expect(done).toContain('SCORE  002200')
})

test('below 6,000 HP the test opens by itself when Claude starts working', async ($, on) => {
  mock.clock(on)
  const opened = world(on, 5000, () => ({ value: { isAnswered: true, text: JSON.stringify(QUIZ), usage: USAGE } }))
  await $.session.start({ cwd: '/repo' })
  await $.turn.start({ turnId: 't1' })
  expect(opened).toContain('brain-test')
})

test('at 6,000 HP or more it stays closed', async ($, on) => {
  mock.clock(on)
  const opened = world(on, 6000, () => ({ value: { isAnswered: true, text: JSON.stringify(QUIZ), usage: USAGE } }))
  await $.session.start({ cwd: '/repo' })
  await $.turn.start({ turnId: 't1' })
  expect(opened).not.toContain('brain-test')
})

test('a small pane still draws every answer, one line each', async ($, on) => {
  mock.clock(on)
  const long = { ...QUIZ, questions: QUIZ.questions.map((q) => ({ ...q, choices: q.choices.map((c) => c + ' '.repeat(3) + 'with a very long explanation that would wrap') })) }
  world(on, 9000, () => ({ value: { isAnswered: true, text: JSON.stringify(long), usage: USAGE } }))
  await $.session.start({ cwd: '/repo' })
  await $.command.run({ command: 'brain-test', args: '' })
  const small = { ...PANE, props: { ...PANE.props, bodyColumns: 30, scroll: { offset: 0, bodyRows: 12 } } }
  const ui = await $.ui.mount(small)
  expect((await ui.findAll({ type: 'Button' })).length).toBe(4)
  expect(await texts(ui)).toContain('…')
  await ui.press({ key: 'ans-1' })
})

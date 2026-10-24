import { expect, mock, test } from 'claude-code/testing'

const band = (surface: 'terminal' | 'desktop', bodyColumns: number) => ({
  plugin: 'brain-bar',
  surface,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

function world(on: any) {
  mock.store(on, { 'hp:/repo': 7420 })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
}

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

test('terminal keeps its block-character bar', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/repo' })
  const ui = await $.ui.mount(band('terminal', 100))
  expect(await texts(ui)).toContain('█')
  expect(await texts(ui)).toContain('7,420 / 10,000 HP')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('desktop draws one row with a bar of flex boxes', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/repo' })
  const ui = await $.ui.mount(band('desktop', 100))
  expect(await ui.find({ key: 'solid' })).toBeDefined()
  expect(await ui.find({ key: 'empty' })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await texts(ui)).not.toContain('█')
  expect(await texts(ui)).toContain('7,420 / 10,000 HP')
  expect(await ui.find({ key: 'brain-test' })).toBeDefined()
})

test('desktop shortens its labels when narrow', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/repo' })
  const ui = await $.ui.mount(band('desktop', 40))
  const t = await texts(ui)
  expect(t).toContain('7,420 HP')
  expect(t).not.toContain('/ 10,000')
})

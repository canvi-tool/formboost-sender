const express = require('express')
const { chromium } = require('playwright')
const app = express()

app.use(express.json())

const FIELD_PATTERNS = {
  company: ['company', 'corp', 'organization', 'kaisha', 'kigyo', '会社', '企業', '法人', 'company_name', 'companyname', 'firm'],
  name: ['fullname', 'full_name', 'shimei', 'namae', 'tantou', 'tantosha', 'person', 'お名前', '担当者', '氏名', 'your_name', 'yourname', 'contact_name'],
  lastname: ['lastname', 'last_name', 'sei', '姓', 'family'],
  firstname: ['firstname', 'first_name', 'mei', '名', 'given'],
  email: ['email', 'mail', 'e-mail', 'address', 'メール', 'メールアドレス'],
  phone: ['tel', 'phone', 'denwa', '電話', 'phone_number', 'telephone', 'mobile'],
  message: ['message', 'body', 'content', 'inquiry', 'comment', 'detail', 'text', 'toiawase', 'naiyou', 'メッセージ', 'お問い合わせ内容', '内容', '詳細', 'biko', 'description', 'question'],
}

function matchField(name, id, placeholder, type, tag) {
  const combined = `${name||''} ${id||''} ${placeholder||''}`.toLowerCase()
  if (type === 'email') return 'email'
  if (type === 'tel') return 'phone'
  if (tag === 'textarea') return 'message'
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    if (patterns.some(p => combined.includes(p.toLowerCase()))) return field
  }
  return null
}

// ラジオ・チェックボックス・セレクトを処理する関数
async function handleChoiceFields(frame) {
  const handled = []

  // ===== ラジオボタン =====
  // 同じname属性でグループ化して、グループごとに1つ選択
  const radioGroups = await frame.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    const groups = {}
    radios.forEach(r => {
      const key = r.name || r.closest('fieldset')?.id || 'unknown'
      if (!groups[key]) groups[key] = []
      const label = document.querySelector(`label[for="${r.id}"]`)?.textContent?.trim()
        || r.closest('label')?.textContent?.trim()
        || r.value || ''
      groups[key].push({ id: r.id, name: r.name, value: r.value, label, checked: r.checked })
    })
    return groups
  })

  for (const [groupName, options] of Object.entries(radioGroups)) {
    if (options.some(o => o.checked)) continue // すでに選択済み

    // 「その他」「お問い合わせ」を優先、なければ最後の選択肢
    const OTHER_KEYWORDS = ['その他', 'other', 'お問い合わせ', 'その他のお問い合わせ', 'general']
    const preferred = options.find(o =>
      OTHER_KEYWORDS.some(kw => (o.label + o.value).toLowerCase().includes(kw))
    ) || options[options.length - 1]

    if (preferred) {
      try {
        const selector = preferred.id
          ? `#${preferred.id}`
          : `input[type="radio"][name="${preferred.name}"][value="${preferred.value}"]`
        await frame.click(selector, { timeout: 3000 })
        handled.push({ type: 'radio', group: groupName, selected: preferred.label || preferred.value })
      } catch (e) { /* skip */ }
    }
  }

  // ===== チェックボックス（利用規約・プライバシーポリシー系） =====
  const checkboxes = await frame.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')).map(el => {
      const label = document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()
        || el.closest('label')?.textContent?.trim()
        || el.value || ''
      return { id: el.id, name: el.name, value: el.value, label, checked: el.checked }
    })
  })

  // 利用規約・プライバシーポリシーは同意チェック
  const AGREE_KEYWORDS = ['利用規約', 'プライバシー', '同意', 'agree', 'privacy', 'terms', '規約']
  for (const cb of checkboxes) {
    if (!cb.checked && AGREE_KEYWORDS.some(kw => (cb.label + cb.value).toLowerCase().includes(kw))) {
      try {
        const selector = cb.id ? `#${cb.id}` : `input[type="checkbox"][name="${cb.name}"]`
        await frame.click(selector, { timeout: 3000 })
        handled.push({ type: 'checkbox_agree', label: cb.label })
      } catch (e) { /* skip */ }
    }
  }

  // ===== セレクトボックス =====
  const selects = await frame.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map(el => ({
      id: el.id,
      name: el.name,
      currentValue: el.value,
      options: Array.from(el.options).map(o => ({ value: o.value, text: o.text }))
    }))
  })

  const OTHER_SELECT_KEYWORDS = ['その他', 'other', 'お問い合わせ', 'general', 'その他のお問い合わせ']
  for (const sel of selects) {
    if (sel.currentValue && sel.currentValue !== '' && sel.currentValue !== sel.options[0]?.value) continue

    const preferred = sel.options.find(o =>
      OTHER_SELECT_KEYWORDS.some(kw => (o.text + o.value).toLowerCase().includes(kw))
    ) || sel.options[sel.options.length - 1]

    if (preferred && preferred.value) {
      try {
        const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`
        await frame.selectOption(selector, preferred.value, { timeout: 3000 })
        handled.push({ type: 'select', name: sel.name, selected: preferred.text })
      } catch (e) { /* skip */ }
    }
  }

  return handled
}

async function getTextFields(frame) {
  try {
    return await frame.evaluate(() => {
      const els = Array.from(document.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'
      ))
      return els.map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        selector: el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${el.name}"]` : null,
        visible: el.offsetParent !== null || el.getBoundingClientRect().width > 0
      })).filter(f => f.selector && f.visible)
    })
  } catch (e) { return [] }
}

app.post('/submit', async (req, res) => {
  const { form_url, sender } = req.body
  const { company, name, email, phone, message } = sender || {}

  if (!form_url) return res.status(400).json({ success: false, error: 'form_url is required' })

  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(20000)

    await page.goto(form_url, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(2000)

    // メインフレーム + iframe両方を処理
    const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())]
    const filled = []
    const choiceHandled = []

    for (const frame of frames) {
      // テキスト系フィールドを入力
      const fields = await getTextFields(frame)
      for (const field of fields) {
        const fieldType = matchField(field.name, field.id, field.placeholder, field.tag === 'textarea' ? 'textarea' : field.type, field.tag)
        let value = null
        if (fieldType === 'company') value = company
        else if (fieldType === 'name') value = name
        else if (fieldType === 'lastname') value = name?.split(/\s+/)[0] || name
        else if (fieldType === 'firstname') value = name?.split(/\s+/)[1] || name
        else if (fieldType === 'email') value = email
        else if (fieldType === 'phone') value = phone
        else if (fieldType === 'message') value = message

        if (value && field.selector) {
          try {
            await frame.fill(field.selector, value, { timeout: 5000 })
            filled.push({ field: fieldType, selector: field.selector })
          } catch {
            try {
              await frame.click(field.selector, { timeout: 3000 })
              await frame.type(field.selector, value, { delay: 30 })
              filled.push({ field: fieldType + '(typed)', selector: field.selector })
            } catch { /* skip */ }
          }
        }
      }

      // ラジオ・チェックボックス・セレクトを処理
      const choices = await handleChoiceFields(frame)
      choiceHandled.push(...choices)
    }

    // 送信ボタンを探す
    let submitted = false
    const submitSelectors = [
      'button[type=submit]',
      'input[type=submit]',
      'button:has-text("送信する")',
      'button:has-text("送信")',
      'button:has-text("確認")',
      'button:has-text("次へ")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
    ]

    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
          submitted = true
          break
        }
      } catch { continue }
    }

    const finalShot = await page.screenshot({ fullPage: false })

    res.json({
      success: submitted,
      filled_fields: filled,
      choice_fields: choiceHandled,
      screenshot_url: `data:image/png;base64,${finalShot.toString('base64')}`,
      page_title: await page.title(),
      final_url: page.url(),
      fields_found: filled.length + choiceHandled.length
    })

  } catch (e) {
    console.error('Error:', e)
    res.status(500).json({ success: false, error: e.message })
  } finally {
    if (browser) await browser.close()
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`Sender running on port ${PORT}`))

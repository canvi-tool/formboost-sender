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

// 送信完了ページの検出キーワード
const COMPLETE_KEYWORDS = [
  '受け付けました', 'ありがとうございました', '送信しました', '完了しました',
  'お問い合わせを受け付け', '送信が完了', 'お問い合わせありがとう',
  'thank you', 'thank_you', 'thanks', 'success', 'complete', 'completed',
  'confirmation', 'confirmed', 'submitted', 'received',
  'ご連絡ありがとう', 'メールをお送り', '担当者よりご連絡'
]

// URLに含まれる完了ページのパターン
const COMPLETE_URL_PATTERNS = [
  'thank', 'thanks', 'complete', 'success', 'confirm', 'done',
  'finish', 'sent', 'received', '/ok', 'complete', 'kanryo', '完了'
]

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

// 完了ページかどうかを判定
async function isCompletePage(page) {
  try {
    const url = page.url().toLowerCase()
    const urlMatch = COMPLETE_URL_PATTERNS.some(p => url.includes(p))
    if (urlMatch) return { detected: true, reason: 'url', text: url }

    const bodyText = await page.evaluate(() => document.body.innerText || '')
    const textMatch = COMPLETE_KEYWORDS.find(kw => bodyText.includes(kw))
    if (textMatch) return { detected: true, reason: 'text', text: textMatch }

    return { detected: false }
  } catch {
    return { detected: false }
  }
}

async function handleChoiceFields(frame) {
  const handled = []

  // ===== ラジオボタン =====
  const radioGroups = await frame.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    const groups = {}
    radios.forEach(r => {
      const key = r.name || r.closest('fieldset')?.id || 'group_' + r.id
      if (!groups[key]) groups[key] = []
      const labelEl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label')
      const label = labelEl?.innerText?.trim() || r.value || ''
      groups[key].push({ id: r.id, name: r.name, value: r.value, label, checked: r.checked })
    })
    return groups
  })

  for (const [, options] of Object.entries(radioGroups)) {
    if (options.some(o => o.checked)) continue
    const OTHER_KEYWORDS = ['その他', 'other', 'お問い合わせ', 'general', 'その他のお問い合わせ', '資料請求']
    const preferred = options.find(o =>
      OTHER_KEYWORDS.some(kw => (o.label + o.value).toLowerCase().includes(kw))
    ) || options[options.length - 1]

    if (preferred) {
      try {
        const selector = preferred.id
          ? `#${preferred.id}`
          : `input[type="radio"][name="${preferred.name}"][value="${preferred.value}"]`
        await frame.click(selector, { timeout: 3000 })
        handled.push({ type: 'radio', selected: preferred.label || preferred.value })
      } catch { /* skip */ }
    }
  }

  // ===== チェックボックス：未チェックのものをすべてチェック =====
  const checkboxes = await frame.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')).map(el => {
      const labelEl = document.querySelector(`label[for="${el.id}"]`) || el.closest('label')
      const label = labelEl?.innerText?.trim() || el.value || ''
      return { id: el.id, name: el.name, value: el.value, label, checked: el.checked }
    })
  })

  for (const cb of checkboxes) {
    if (cb.checked) continue
    try {
      const selector = cb.id
        ? `#${cb.id}`
        : cb.name ? `input[type="checkbox"][name="${cb.name}"]` : null
      if (selector) {
        await frame.click(selector, { timeout: 3000 })
        handled.push({ type: 'checkbox', label: cb.label || cb.value })
      }
    } catch { /* skip */ }
  }

  // ===== セレクトボックス =====
  const selects = await frame.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map(el => ({
      id: el.id,
      name: el.name,
      currentValue: el.value,
      options: Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }))
    }))
  })

  const OTHER_SELECT_KEYWORDS = ['その他', 'other', 'お問い合わせ', 'general', 'その他のお問い合わせ']
  for (const sel of selects) {
    const firstOption = sel.options[0]
    const isUnselected = !sel.currentValue || (sel.currentValue === firstOption?.value && !firstOption?.value)
    if (!isUnselected) continue
    const validOptions = sel.options.filter(o => o.value)
    const preferred = validOptions.find(o =>
      OTHER_SELECT_KEYWORDS.some(kw => (o.text + o.value).toLowerCase().includes(kw))
    ) || validOptions[validOptions.length - 1]
    if (preferred?.value) {
      try {
        const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`
        await frame.selectOption(selector, preferred.value, { timeout: 3000 })
        handled.push({ type: 'select', name: sel.name, selected: preferred.text })
      } catch { /* skip */ }
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
  } catch { return [] }
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
    page.setDefaultTimeout(30000)

    await page.goto(form_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(2000)

    const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())]
    const filled = []
    const choiceHandled = []

    for (const frame of frames) {
      const fields = await getTextFields(frame)
      for (const field of fields) {
        const fieldType = matchField(field.name, field.id, field.placeholder,
          field.tag === 'textarea' ? 'textarea' : field.type, field.tag)
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
      const choices = await handleChoiceFields(frame)
      choiceHandled.push(...choices)
    }

    // フォームフィールドが1つも見つからない場合は早期リターン
    if (filled.length === 0 && choiceHandled.length === 0) {
      const shot = await page.screenshot({ fullPage: false })
      await browser.close()
      browser = null
      return res.json({
        success: false,
        clicked_submit: false,
        complete_detected: false,
        filled_fields: [],
        choice_fields: [],
        screenshot_url: `data:image/png;base64,${shot.toString('base64')}`,
        sent_content: { company: company||'', name: name||'', email: email||'', phone: phone||'', message: (message||'').slice(0,100) },
        error: 'フォームフィールドが見つかりませんでした（フォームURLが正しくない可能性があります）',
        page_title: await page.title(),
        final_url: page.url(),
        fields_found: 0
      })
    }

    // 送信ボタンをクリック
    let clickedSubmit = false
    const submitSelectors = [
      'button[type=submit]', 'input[type=submit]',
      'button:has-text("送信する")', 'button:has-text("送信")',
      'button:has-text("確認")', 'button:has-text("次へ")',
      'button:has-text("Submit")', 'button:has-text("Send")',
      '[class*="submit"]',
    ]
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
          clickedSubmit = true
          break
        }
      } catch { continue }
    }

    // SPA対応：送信後にDOMが変わるのを最大5秒待つ
    if (clickedSubmit) {
      const SPA_COMPLETE_SELECTORS = COMPLETE_KEYWORDS.map(kw => `:has-text("${kw}")`).slice(0, 5)
      for (const sel of SPA_COMPLETE_SELECTORS) {
        try {
          await page.waitForSelector(sel, { timeout: 5000 })
          break
        } catch { continue }
      }
      // 追加で1秒待機（アニメーション完了待ち）
      await page.waitForTimeout(1000)
    }

    // 完了ページ判定（URL変化 or DOMテキスト）
    const completeCheck = await isCompletePage(page)
    const success = clickedSubmit && completeCheck.detected

    // 完了ページのスクリーンショット
    const finalShot = await page.screenshot({ fullPage: false })
    const screenshotBase64 = `data:image/png;base64,${finalShot.toString('base64')}`

    // 送付内容サマリー
    const sentContent = {
      company: company || '',
      name: name || '',
      email: email || '',
      phone: phone || '',
      message: (message || '').slice(0, 100) + ((message || '').length > 100 ? '...' : '')
    }

    res.json({
      success,
      clicked_submit: clickedSubmit,
      complete_detected: completeCheck.detected,
      complete_reason: completeCheck.reason,
      complete_keyword: completeCheck.text,
      filled_fields: filled,
      choice_fields: choiceHandled,
      screenshot_url: screenshotBase64,
      sent_content: sentContent,
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

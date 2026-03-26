const express = require('express')
const { chromium } = require('playwright')
const app = express()

app.use(express.json())

// フィールドマッピングパターン
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

async function getFields(context) {
  // メインフレームとiframeの両方を検索
  const frames = context.frames ? context.frames() : [context]
  const allFields = []
  
  for (const frame of frames) {
    try {
      const fields = await frame.evaluate(() => {
        const els = Array.from(document.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select'
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
      allFields.push({ frame, fields })
    } catch (e) { /* iframe cross-origin など */ }
  }
  return allFields
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

    // ページを開く（動的コンテンツのため networkidle で待機）
    await page.goto(form_url, { waitUntil: 'networkidle', timeout: 20000 })
    
    // 追加で2秒待って動的フォームが描画されるのを待つ
    await page.waitForTimeout(2000)

    const frameData = await getFields(page)
    const filled = []

    for (const { frame, fields } of frameData) {
      for (const field of fields) {
        const fieldType = matchField(field.name, field.id, field.placeholder, field.tag === 'textarea' ? 'textarea' : field.type, field.tag)
        
        let value = null
        if (fieldType === 'company') value = company
        else if (fieldType === 'name') value = name
        else if (fieldType === 'lastname') value = name?.split(' ')[0] || name
        else if (fieldType === 'firstname') value = name?.split(' ')[1] || name
        else if (fieldType === 'email') value = email
        else if (fieldType === 'phone') value = phone
        else if (fieldType === 'message') value = message

        if (value && field.selector) {
          try {
            await frame.fill(field.selector, value, { timeout: 5000 })
            filled.push({ field: fieldType, selector: field.selector })
          } catch (e) {
            // type()でフォールバック
            try {
              await frame.click(field.selector, { timeout: 3000 })
              await frame.type(field.selector, value, { delay: 30 })
              filled.push({ field: fieldType + '(typed)', selector: field.selector })
            } catch (e2) { /* skip */ }
          }
        }
      }
    }

    // 入力後スクリーンショット
    const afterFillShot = await page.screenshot({ fullPage: false })

    // 送信ボタンを探す
    let submitted = false
    const submitSelectors = [
      'button[type=submit]',
      'input[type=submit]',
      'button:has-text("送信")',
      'button:has-text("確認")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
      '[class*="submit"]',
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
      } catch (e) { continue }
    }

    const finalShot = await page.screenshot({ fullPage: false })
    const screenshotUrl = `data:image/png;base64,${finalShot.toString('base64')}`

    res.json({
      success: submitted,
      filled_fields: filled,
      screenshot_url: screenshotUrl,
      page_title: await page.title(),
      final_url: page.url(),
      fields_found: frameData.reduce((acc, { fields }) => acc + fields.length, 0)
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

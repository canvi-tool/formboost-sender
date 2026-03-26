const express = require('express')
const { chromium } = require('playwright')
const { Storage } = require('@google-cloud/storage')
const app = express()

app.use(express.json())

const storage = new Storage()
const BUCKET = process.env.GCS_BUCKET || 'formboost-screenshots'

// フィールドマッピング（よくある名前パターン）
const FIELD_PATTERNS = {
  company: ['company', 'corp', 'organization', 'kaisha', 'kigyo', '会社', '企業', '法人', 'busho', 'company_name'],
  name: ['name', 'fullname', 'full_name', 'shimei', 'namae', 'sei', 'mei', 'tantou', 'tantosha', 'person', 'お名前', '担当', '氏名'],
  email: ['email', 'mail', 'e-mail', 'address', 'メール', 'メールアドレス'],
  phone: ['tel', 'phone', 'fax', 'denwa', '電話', 'phone_number', 'telephone'],
  message: ['message', 'body', 'content', 'inquiry', 'comment', 'detail', 'text', 'toiawase', 'naiyou', 'メッセージ', 'お問い合わせ', '内容', '詳細', 'biko'],
}

function matchField(name, placeholder, type) {
  const combined = `${(name || '')} ${(placeholder || '')}`.toLowerCase()
  
  if (type === 'email') return 'email'
  if (type === 'tel') return 'phone'
  if (type === 'textarea' || name === 'textarea') return 'message'
  
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    if (patterns.some(p => combined.includes(p))) return field
  }
  return null
}

app.post('/submit', async (req, res) => {
  const { form_url, sender } = req.body
  const { company, name, email, phone, message } = sender || {}

  if (!form_url) return res.status(400).json({ success: false, error: 'form_url is required' })

  let browser
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
    const page = await browser.newPage()
    
    // タイムアウト設定
    page.setDefaultTimeout(15000)
    
    await page.goto(form_url, { waitUntil: 'networkidle', timeout: 15000 })
    
    // フォームフィールドを取得
    const fields = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select'))
      return inputs.map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null
      })).filter(f => f.selector)
    })

    const filled = []
    
    for (const field of fields) {
      const fieldType = matchField(field.name + ' ' + field.id, field.placeholder, field.tag === 'textarea' ? 'textarea' : field.type)
      
      let value = null
      if (fieldType === 'company') value = company
      else if (fieldType === 'name') value = name
      else if (fieldType === 'email') value = email
      else if (fieldType === 'phone') value = phone
      else if (fieldType === 'message') value = message
      
      if (value && field.selector) {
        try {
          await page.fill(field.selector, value)
          filled.push({ field: fieldType, selector: field.selector })
        } catch (e) {
          console.log('Fill error:', field.selector, e.message)
        }
      }
    }

    // 入力後のスクショ（送信前）
    const beforeShot = await page.screenshot({ fullPage: false })
    
    // 送信ボタンを探してクリック
    const submitSelector = 'button[type=submit], input[type=submit], button:has-text("送信"), button:has-text("Submit"), button:has-text("確認")'
    let submitted = false
    try {
      const submitBtn = await page.$(submitSelector)
      if (submitBtn) {
        await submitBtn.click()
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        submitted = true
      }
    } catch (e) {
      console.log('Submit error:', e.message)
    }

    // 送信後のスクショ
    const afterShot = await page.screenshot({ fullPage: false })

    // Cloud Storageに保存
    const timestamp = Date.now()
    const filename = `screenshots/${timestamp}_after.png`
    let screenshotUrl = null
    
    try {
      const bucket = storage.bucket(BUCKET)
      const file = bucket.file(filename)
      await file.save(afterShot, { contentType: 'image/png', public: true })
      screenshotUrl = `https://storage.googleapis.com/${BUCKET}/${filename}`
    } catch (e) {
      console.log('GCS error:', e.message)
      // GCSが使えない場合はbase64で返す
      screenshotUrl = `data:image/png;base64,${afterShot.toString('base64')}`
    }

    res.json({
      success: submitted,
      filled_fields: filled,
      screenshot_url: screenshotUrl,
      page_title: await page.title(),
      final_url: page.url()
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

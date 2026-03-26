import { NextRequest, NextResponse } from 'next/server'

const SENDER_URL = process.env.SENDER_URL || ''

export async function POST(req: NextRequest) {
  const { form_url, sender } = await req.json()
  
  if (!form_url) return NextResponse.json({ success: false, error: 'form_url is required' })
  if (!SENDER_URL) return NextResponse.json({ success: false, error: 'SENDER_URL未設定' })

  try {
    const res = await fetch(`${SENDER_URL}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_url, sender }),
      signal: AbortSignal.timeout(60000) // 60秒タイムアウト
    })
    
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('Sender error:', e)
    return NextResponse.json({ success: false, error: e.message })
  }
}

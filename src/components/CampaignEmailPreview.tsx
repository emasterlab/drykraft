import { campaignEmail } from '@/lib/campaign-email.mjs'

export function CampaignEmailPreview({ subject, body, senderName, senderEmail }: { subject: string; body: string; senderName: string; senderEmail?: string }) {
  const sample = (value: string) => value.replaceAll('{{record.data.name}}', 'Sample customer')
  const { html } = campaignEmail({ subject: sample(subject) || 'Your subject', body: sample(body) || 'Your message appears here.', senderName, senderEmail, unsubscribeUrl: 'https://example.test/unsubscribe' })
  return <div className="campaign-email-preview"><p className="settings-note">HTML email preview · Sample customer values</p><iframe title="Formatted email preview" srcDoc={html} sandbox="" referrerPolicy="no-referrer" /></div>
}

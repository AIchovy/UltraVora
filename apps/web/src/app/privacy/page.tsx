// apps/web/src/app/privacy/page.tsx
import type { Metadata } from "next";
import { LegalArticle, type LegalDoc } from "@/components/marketing/legal-article";
import { baseOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Privacy Policy — UltraVora",
  description: "How UltraVora collects, uses, and protects your information.",
  alternates: { canonical: "/privacy" },
  openGraph: { ...baseOpenGraph, title: "Privacy Policy — UltraVora", description: "How UltraVora collects, uses, and protects your information.", url: "/privacy" },
};

const privacyPolicy: LegalDoc = {
  title: "Privacy Policy",
  effectiveDate: "July 9, 2026",
  intro: [
    "This Privacy Policy explains what information UltraVora (\"we\", \"us\", \"our\") collects when you use our AI video studio at ultra-vora.com, how we use it, who we share it with, and the choices you have. UltraVora turns a prompt about your product into a finished promo video: we research your product (including fetching web pages and URLs you provide), plan the creative, write a script, generate an AI voiceover, and render the video on our servers, with you reviewing and approving along the way.",
    "We have tried to write this policy in plain English, because we actually want you to read it. If anything is unclear, email us at support@ultra-vora.com and we will explain."
  ],
  sections: [
    {
      heading: "Information we collect",
      paragraphs: [
        "We collect only what we need to run UltraVora. Here is the full list."
      ],
      bullets: [
        "Account information. If you sign in with Google, we receive basic profile information from Google, such as your name, email address, and profile picture. If you sign up with email and password, we collect your email address and the password you choose, and we verify the account with a one-time code emailed to you (sent from the support.ultra-vora.com domain via the Resend email service). You also choose a display nickname.",
        "Content you provide. Your prompts, product descriptions, the URLs you ask us to research, media and assets you upload, your chat feedback and tweak requests, and the videos we generate for you.",
        "Usage and log data. Basic technical records such as your IP address, browser type, and the actions you take in the service, including likes you give to published videos. We use these to keep UltraVora running, debug problems, and prevent abuse.",
        "Cookies. We use functional session cookies to keep you signed in. We do not use advertising trackers, and we do not currently use any third-party analytics.",
        "Payment information. If you buy credits or a subscription (where offered), payment is handled by third-party payment processors. We do not store your full payment card number. We keep records of your credit balance and your purchases."
      ]
    },
    {
      heading: "How we use your information",
      paragraphs: [
        "We use your information to do the things you ask us to do, and to keep the service working. Specifically:"
      ],
      bullets: [
        "Create your videos. We use your prompts, product details, URLs, and uploads to research your product, plan the creative, write the script, generate the AI voiceover, and render the finished video. Generation runs on our servers, so your session continues even if you close your browser.",
        "Run your account. We use your email and sign-in details to authenticate you, keep you signed in with session cookies, and send transactional emails such as verification codes.",
        "Handle credits and billing. We track your credit balance, including any free credits, and process paid purchases through our payment processors when paid plans are offered.",
        "Support you. We use the information you send us to answer your questions and fix problems.",
        "Protect the service. We use usage and log data to secure the service, prevent abuse, and debug.",
        "Comply with the law, where we are legally required to."
      ],
      afterBullets: [
        "We do not sell your personal information, and we do not use it for third-party advertising."
      ]
    },
    {
      heading: "Who we share information with",
      paragraphs: [
        "We do not share your personal information with anyone except the service providers we need to operate UltraVora, and in the limited situations listed below."
      ],
      bullets: [
        "Google Cloud Platform. UltraVora is hosted on Google Cloud, including our databases and file storage. Our servers are located in the United States.",
        "Resend. We use Resend to deliver transactional emails, such as the one-time verification codes sent when you create an email account.",
        "AI model providers. Generating your video requires sending your prompts, product descriptions, URLs, uploaded assets, and feedback to third-party AI model providers (for example, Google's Gemini models) to produce the research, script, voiceover, and video. These providers process your content under their own terms.",
        "Payment processors. When paid credit top-ups or subscriptions are offered, third-party payment processors handle the payment. They receive your payment details directly; we never store your full card number.",
        "Legal requirements. We may disclose information if we are required to by law or valid legal process, or to protect the rights and safety of our users or the service.",
        "Business transfers. If UltraVora is acquired, merges, or transfers its assets, your information may transfer as part of that deal. We would post notice of any such change on the site."
      ],
      afterBullets: [
        "That is the whole list. There are no advertising networks, data brokers, or third-party analytics services receiving your data. Separately, if you choose to publish a video to Product Plaza or share a direct public link, that video — with its title, your display name, and your avatar — becomes visible to anyone; see 'Product Plaza and public content' below."
      ]
    },
    {
      heading: "Product Plaza and public content",
      paragraphs: [
        "Publishing is always your choice. Nothing you make on UltraVora is public unless you decide to publish it.",
        "If you publish a finished video to Product Plaza, our public gallery, it becomes visible to anyone on the internet, including logged-out visitors and search engines. A published entry shows the video itself, its title, your display name and avatar, its like count, and, if you added one, an outbound link to your product.",
        "You can also share direct links to your videos. Anyone with such a link can view the video, whether or not they have an UltraVora account.",
        "You can unpublish a video at any time, which removes it from Product Plaza. Unpublishing also disables any direct public link to the video. But please think before you publish: while something is public, other people and search engines can view, copy, or cache it, and we cannot retrieve copies that others have made."
      ]
    },
    {
      heading: "Where your data is processed",
      paragraphs: [
        "UltraVora runs on servers in the United States. If you use the service from somewhere else, your information will be transferred to and processed in the United States, and by the third-party providers listed above."
      ]
    },
    {
      heading: "Data retention and deletion",
      paragraphs: [
        "We keep your account information and content for as long as your account is active, so that your projects, videos, and credit balance are there when you come back.",
        "If you want to delete your account, or specific content or personal information, email us at support@ultra-vora.com and we will take care of it. We may keep some records where we are legally required to, such as purchase records.",
        "Unpublishing a video removes it from Product Plaza but does not delete it from your account; deleting is a separate request you can make at any time."
      ]
    },
    {
      heading: "Security",
      paragraphs: [
        "We take reasonable technical and organizational measures to protect your information, and access to it is limited to what is needed to operate the service.",
        "That said, no online service can guarantee absolute security, and we will not pretend otherwise. If you believe your account has been compromised, contact us at support@ultra-vora.com right away."
      ]
    },
    {
      heading: "Your rights and choices",
      paragraphs: [
        "Depending on where you live, you may have rights to access, correct, or delete your personal information. To exercise any of these, email support@ultra-vora.com and we will respond to your request.",
        "You are also always in control of a few things directly: you decide what you publish to Product Plaza, and you can unpublish a video at any time. The only cookies we set are the functional ones needed to keep you signed in."
      ]
    },
    {
      heading: "Children",
      paragraphs: [
        "UltraVora is not directed at children under 13, and we do not knowingly collect personal information from them. If you believe a child under 13 has created an account or given us personal information, contact us at support@ultra-vora.com and we will delete it."
      ]
    },
    {
      heading: "Changes to this policy",
      paragraphs: [
        "As UltraVora evolves, we may update this policy. When we do, we will post the updated version on the site with a new effective date, and for significant changes we will give notice on the site.",
        "If you keep using UltraVora after a change takes effect, the updated policy applies to you. If you do not agree with a change, you can stop using the service and ask us to delete your data."
      ]
    },
    {
      heading: "Contact us",
      paragraphs: [
        "If you have any questions, requests, or concerns about this policy or your personal information, email us at support@ultra-vora.com. That is our only support channel, and it is the fastest way to reach us."
      ]
    }
  ]
};

export default function PrivacyPolicyPage(): React.ReactElement {
  return <LegalArticle doc={privacyPolicy} />;
}

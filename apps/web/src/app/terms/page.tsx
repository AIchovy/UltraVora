// apps/web/src/app/terms/page.tsx
import type { Metadata } from "next";
import { LegalArticle, type LegalDoc } from "@/components/marketing/legal-article";
import { baseOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Terms of Service — UltraVora",
  description: "The agreement between you and UltraVora for using the AI video studio.",
  alternates: { canonical: "/terms" },
  openGraph: { ...baseOpenGraph, title: "Terms of Service — UltraVora", description: "The agreement between you and UltraVora for using the AI video studio.", url: "/terms" },
};

const termsOfService: LegalDoc = {
  title: "Terms of Service",
  effectiveDate: "July 22, 2026",
  intro: [
    "UltraVora is an AI video studio: you describe your product, and we research it, plan the creative, write a script, generate an AI voiceover, and render a finished promo video for you. These Terms of Service are the agreement between you and UltraVora (\"we\", \"us\", \"our\") for using ultra-vora.com and everything the service does.",
    "By creating an account or using UltraVora, you agree to these terms. If you do not agree with them, please do not use the service. We have tried to write these terms in plain English — if anything is unclear, email us at support@ultra-vora.com and we will explain."
  ],
  sections: [
    {
      heading: "1. What these terms cover",
      paragraphs: [
        "These terms apply to your use of the UltraVora website, your account, the video generation tools, the credits system, and the Product Plaza public gallery. They cover both free and paid use of the service.",
        "Our Privacy Policy describes how we handle your personal information and forms part of these terms. Where these terms talk about your content and your data, the Privacy Policy has the details."
      ]
    },
    {
      heading: "2. The service",
      paragraphs: [
        "UltraVora turns a written prompt about your product into a finished promo video. When you start a project, the service researches your product (including fetching web pages and URLs you provide), plans the creative direction, writes a script, generates an AI voiceover, and renders the video on our servers.",
        "You stay in control at key stages: you review and approve the creative brief and the script, and you can request tweaks and re-renders of the finished video. Generation runs on our servers, so your session keeps working even if you close your browser.",
        "The heavy lifting is done by AI. We use third-party AI model providers (for example, Google's Gemini models) to generate research, scripts, voiceover, and video, which means your prompts and content are sent to those providers as part of generation. Section 7 explains what that means for the videos you get back."
      ]
    },
    {
      heading: "3. Your account",
      paragraphs: [
        "You can sign in with Google or create an account with an email address and password. New email accounts are verified with a one-time code we email you (sent from our support.ultra-vora.com domain via the Resend email service). You choose a display nickname, which is shown alongside anything you publish.",
        "You must be at least 13 years old to use UltraVora. The service is not directed at children under 13, and you may not create an account for anyone under that age.",
        "Please give us accurate account information and keep your password and sign-in access to yourself. You are responsible for activity that happens under your account. We use session cookies to keep you signed in — these are functional authentication cookies only; we do not use advertising trackers and do not currently use any third-party analytics (see our Privacy Policy).",
        "If you think someone else has accessed your account, contact us at support@ultra-vora.com right away."
      ]
    },
    {
      heading: "4. Credits, payments, and refunds",
      paragraphs: [
        "Usage of UltraVora is measured in credits. New users may receive free credits to try the service. We may offer paid credit top-ups and subscriptions — current plans and prices are shown on our pricing page, which may change over time.",
        "When payments are offered, they are processed by third-party payment processors. UltraVora does not store your full payment card number.",
        "Credits have no cash value, cannot be transferred to another account or person, and are generally non-refundable, except where a refund is required by law. If you believe you were charged in error, contact us at support@ultra-vora.com and we will look into it."
      ]
    },
    {
      heading: "5. Your content and the license you give us",
      paragraphs: [
        "\"Your content\" means the things you bring to or create with UltraVora, including:"
      ],
      bullets: [
        "prompts and product descriptions you write",
        "URLs you ask us to research",
        "media and assets you upload",
        "feedback and messages you send in project chats",
        "the videos generated for you"
      ],
      afterBullets: [
        "You retain ownership of the content you upload. So that the service can work at all, you grant UltraVora a license to host, process, and display your content — solely to operate the service for you. That includes storing your files, sending your prompts and content to our third-party AI providers to generate your video, and showing your work back to you in the studio. We do not claim ownership of your content and we do not use this license for anything beyond running the service.",
        "If you publish a video to Product Plaza or share a direct public video link, you additionally grant us a license to publicly display and stream that video, which lasts until you unpublish it. Section 9 covers publishing in detail."
      ]
    },
    {
      heading: "6. Our intellectual property",
      paragraphs: [
        "UltraVora owns the platform: the software, the website, the design, and the UltraVora branding. These terms give you the right to use the service; they do not give you any rights in our software or brand.",
        "You may not copy, resell, or create derivative versions of the platform itself. Your rights in the videos and content you create are covered in sections 5 and 7 — this section is only about the service itself."
      ]
    },
    {
      heading: "7. Generated videos and AI outputs",
      paragraphs: [
        "To the maximum extent permitted by law, and subject to the terms of the third-party AI providers we use, you own the videos UltraVora generates for you. You can use them to promote your product, post them wherever you like, and use them commercially.",
        "That said, outputs are AI-generated and may be inaccurate or imperfect. Scripts can contain mistakes, voiceovers can mispronounce things, and visuals may not be exactly what you intended. You are responsible for reviewing every video before using it commercially — the review and approval stages exist for exactly this reason.",
        "You are also responsible for having the rights to everything you provide as input: your product names, logos, images, footage, and the claims you make about your product. Do not ask us to make videos using material you do not have the right to use, and make sure any claims in your videos about your product are ones you can stand behind."
      ]
    },
    {
      heading: "8. Acceptable use",
      paragraphs: [
        "We want UltraVora to be used for honest promotion of real products. When using the service, you agree not to:"
      ],
      bullets: [
        "generate NSFW, adult, pornographic, sexual, or sexually explicit content of any kind — this is strictly prohibited, including in prompts, uploaded material, and generated videos",
        "create face-swap, deepfake, or other face-manipulation content, or depict any real person without their explicit consent",
        "create or publish content that is illegal, infringing, deceptive, or harmful, including content that exploits or endangers minors, promotes violence or self-harm, or constitutes hate speech or harassment",
        "use content you do not have the rights to, including other people's trademarks, media, or likeness",
        "make deceptive or fraudulent claims in videos, or impersonate another person or business",
        "attempt to break, probe, or get around the security of the service, including attempts to bypass content moderation",
        "scrape the service at scale or access it with automated tools in ways it is not designed for",
        "abuse the service, including interfering with other users, circumventing credit limits, or overloading our systems"
      ],
      afterBullets: [
        "Every generation prompt is screened by automated content moderation before any video is produced, and prompts that violate these rules are rejected. If content or behavior violates these rules, we may remove the content, unpublish videos, and suspend or terminate the account involved."
      ]
    },
    {
      heading: "9. Publishing to Product Plaza",
      paragraphs: [
        "Publishing is always your choice. Finished videos stay private unless you choose to publish them to Product Plaza, our public gallery, or share a direct public video link.",
        "Published videos are visible to anyone — including visitors who are not logged in, and search engines. A published video shows the video itself, its title, your display name and avatar, a like count, and, if you added one, an outbound link to your product.",
        "You can unpublish a video at any time, which ends the public-display license described in section 5 and removes it from Product Plaza. Unpublishing also disables any direct public link to the video. Keep in mind that content that was public may have been viewed, shared, or copied by others while it was up — we cannot undo that.",
        "We may remove or unpublish content from Product Plaza that violates these terms."
      ]
    },
    {
      heading: "10. Termination",
      paragraphs: [
        "You can stop using UltraVora at any time. If you want your account closed, contact us at support@ultra-vora.com and we will take care of it.",
        "We may suspend or terminate your account if you violate these terms, if your use puts the service or other users at risk, or if we are required to by law. Where it is reasonable to do so, we will tell you why.",
        "If your account is terminated, your right to use the service ends and your published videos come down. Credits are handled as described in section 4: they have no cash value and are generally non-refundable except where the law requires otherwise. After your account is closed, you can ask us to delete your content and personal information as described in our Privacy Policy (email support@ultra-vora.com); we may keep records we are legally required to keep, such as purchase records."
      ]
    },
    {
      heading: "11. Changes to the service and to these terms",
      paragraphs: [
        "UltraVora is actively developed, and the service will change over time — features may be added, changed, or removed, including how credits and pricing work. We do not promise that any particular feature will remain available.",
        "We may also update these terms and our Privacy Policy. When we make material changes, we will give notice on the site and update the effective date at the top of the document. If you keep using the service after a change takes effect, that means you accept the updated terms. If you do not agree with a change, stop using the service and contact us about closing your account."
      ]
    },
    {
      heading: "12. Disclaimers",
      paragraphs: [
        "UltraVora is provided \"as is\" and \"as available\", without warranties of any kind, whether express or implied — including implied warranties of merchantability, fitness for a particular purpose, and non-infringement, to the extent those can be disclaimed under the law that applies to you.",
        "In plain terms: we work hard to make the service reliable and the outputs good, but we do not guarantee that the service will be uninterrupted or error-free, or that generated videos will be accurate, complete, or fit for your specific purpose. As section 7 says, review your videos before you rely on them."
      ]
    },
    {
      heading: "13. Limitation of liability",
      paragraphs: [
        "To the maximum extent permitted by law, UltraVora will not be liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, lost revenue, or lost data, arising out of or related to the service or these terms.",
        "To the maximum extent permitted by law, our total liability for all claims arising out of or related to the service or these terms is capped at the greater of (a) the amounts you paid us in the 12 months before the claim arose, or (b) USD 100.",
        "Some places do not allow certain liability limits, so parts of this section may not apply to you. Nothing in these terms limits liability that cannot legally be limited."
      ]
    },
    {
      heading: "14. Your data rights",
      paragraphs: [
        "Depending on where you live, you may have rights to access, correct, or delete your personal information. To exercise those rights, contact us at support@ultra-vora.com and we will help.",
        "Our servers run on Google Cloud Platform in the United States, so by using the service you understand your data is processed there. Our Privacy Policy has the full details on what we collect and how we use it."
      ]
    },
    {
      heading: "15. Severability and entire agreement",
      paragraphs: [
        "If any part of these terms is found to be unenforceable, that part will be limited or removed to the minimum extent necessary, and the rest of the terms will stay in full effect.",
        "These terms, together with the Privacy Policy, are the entire agreement between you and UltraVora about the service, and they replace any earlier agreements or understandings about it. If we do not enforce a part of these terms at some point, that is not a waiver — we can still enforce it later."
      ]
    },
    {
      heading: "16. Contact",
      paragraphs: [
        "Questions, concerns, or requests about these terms or the service: email us at support@ultra-vora.com. That is the best and only official channel to reach us, and a real person reads it."
      ]
    }
  ]
};

export default function TermsOfServicePage(): React.ReactElement {
  return <LegalArticle doc={termsOfService} />;
}

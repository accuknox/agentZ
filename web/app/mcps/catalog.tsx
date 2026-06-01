import {
  Adobe,
  Ahrefs,
  Asana,
  Atlassian,
  Calendly,
  Canva,
  ClickUp,
  Cloudflare,
  Cloudinary,
  Figma,
  GitHubDark,
  Gmail,
  GoogleCalendar,
  GoogleCloud,
  GoogleDrive,
  GranolaDark,
  HuggingFace,
  Linear,
  Microsoft,
  Netlify,
  Notion,
  PDF,
  PayPal,
  PlanetScaleDark,
  PostHog,
  Postman,
  SanityDark,
  Sentry,
  Slack,
  Stripe,
  Supabase,
  ThreejsDark,
  UdemyDark,
  VercelDark,
  Webflow,
  WordPress,
  Zoom,
} from "@ridemountainpig/svgl-react"
import { Globe } from "lucide-react"
import type { SVGProps } from "react"

export type McpServer = {
  name: string
  mcpUrl: string
  icon: React.ComponentType<SVGProps<SVGSVGElement>>
}

export const mcpServers = [
  {
    name: "AdisInsight",
    mcpUrl: "https://adisinsight-mcp.springer.com/mcp",
    icon: Globe,
  },
  {
    name: "Adobe Experience Manager",
    mcpUrl: "https://mcp.adobeaemcloud.com/adobe/mcp/aem",
    icon: Adobe,
  },
  {
    name: "Adobe Marketing Agent",
    mcpUrl: "https://aep-ai-ama.adobe.io/mcp",
    icon: Adobe,
  },
  {
    name: "Ahrefs",
    mcpUrl: "https://api.ahrefs.com/mcp/mcp",
    icon: Ahrefs,
  },
  {
    name: "AirOps",
    mcpUrl: "https://app.airops.com/mcp",
    icon: Globe,
  },
  {
    name: "Airtable",
    mcpUrl: "https://mcp.airtable.com/mcp",
    icon: Globe,
  },
  {
    name: "Airwallex Developer",
    mcpUrl: "https://mcp-demo.airwallex.com/developer",
    icon: Globe,
  },
  {
    name: "Amplitude",
    mcpUrl: "https://mcp.amplitude.com/mcp",
    icon: Globe,
  },
  {
    name: "Apollo.io",
    mcpUrl: "https://mcp.apollo.io/mcp",
    icon: Globe,
  },
  {
    name: "Asana",
    mcpUrl: "https://mcp.asana.com/v2/mcp",
    icon: Asana,
  },
  {
    name: "Atlassian Rovo",
    mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    icon: Atlassian,
  },
  {
    name: "Attio",
    mcpUrl: "https://mcp.attio.com/mcp",
    icon: Globe,
  },
  {
    name: "Aura",
    mcpUrl: "https://mcp.auraintelligence.com/mcp",
    icon: Globe,
  },
  {
    name: "AWS Marketplace",
    mcpUrl: "https://marketplace-mcp.us-east-1.api.aws/mcp",
    icon: Globe,
  },
  {
    name: "Base44",
    mcpUrl: "https://app.base44.com/mcp",
    icon: Globe,
  },
  {
    name: "Bigdata.com",
    mcpUrl: "https://mcp.bigdata.com/",
    icon: Globe,
  },
  {
    name: "BioRender",
    mcpUrl: "https://mcp.services.biorender.com/mcp",
    icon: Globe,
  },
  {
    name: "Bitly",
    mcpUrl: "https://api-ssl.bitly.com/v4/mcp",
    icon: Globe,
  },
  {
    name: "Box",
    mcpUrl: "https://mcp.box.com",
    icon: Globe,
  },
  {
    name: "Brex",
    mcpUrl: "https://api.brex.com/mcp",
    icon: Globe,
  },
  {
    name: "Calendly",
    mcpUrl: "https://mcp.calendly.com",
    icon: Calendly,
  },
  {
    name: "Candid",
    mcpUrl: "https://mcp.candid.org/mcp",
    icon: Globe,
  },
  {
    name: "Canva",
    mcpUrl: "https://mcp.canva.com/mcp",
    icon: Canva,
  },
  {
    name: "CB Insights",
    mcpUrl: "https://mcp.cbinsights.com",
    icon: Globe,
  },
  {
    name: "CData Connect AI",
    mcpUrl: "https://mcp.cloud.cdata.com/mcp",
    icon: Globe,
  },
  {
    name: "Chronograph",
    mcpUrl: "https://ai.chronograph.pe/mcp",
    icon: Globe,
  },
  {
    name: "Circleback",
    mcpUrl: "https://app.circleback.ai/api/mcp",
    icon: Globe,
  },
  {
    name: "Clarify",
    mcpUrl: "https://api.clarify.ai/mcp",
    icon: Globe,
  },
  {
    name: "Clay",
    mcpUrl: "https://api.clay.com/v3/mcp",
    icon: Globe,
  },
  {
    name: "ClickUp",
    mcpUrl: "https://mcp.clickup.com/mcp",
    icon: ClickUp,
  },
  {
    name: "Close",
    mcpUrl: "https://mcp.close.com/mcp",
    icon: Globe,
  },
  {
    name: "Cloudflare Developer Platform",
    mcpUrl: "https://bindings.mcp.cloudflare.com/mcp",
    icon: Cloudflare,
  },
  {
    name: "Cloudinary",
    mcpUrl: "https://asset-management.mcp.cloudinary.com/sse",
    icon: Cloudinary,
  },
  {
    name: "Common Room",
    mcpUrl: "https://mcp.commonroom.io/mcp",
    icon: Globe,
  },
  {
    name: "Consensus",
    mcpUrl: "https://mcp.consensus.app/mcp",
    icon: Globe,
  },
  {
    name: "Contentsquare",
    mcpUrl: "https://api.contentsquare.com/mcp",
    icon: Globe,
  },
  {
    name: "Context7",
    mcpUrl: "https://mcp.context7.com/mcp",
    icon: Globe,
  },
  {
    name: "Coupler.io",
    mcpUrl: "https://mcp.coupler.io/mcp/",
    icon: Globe,
  },
  {
    name: "Craft",
    mcpUrl: "https://mcp.craft.do/my/mcp",
    icon: Globe,
  },
  {
    name: "Crossbeam",
    mcpUrl: "https://mcp.crossbeam.com",
    icon: Globe,
  },
  {
    name: "Daloopa",
    mcpUrl: "https://mcp.daloopa.com/server/mcp",
    icon: Globe,
  },
  {
    name: "DevRev",
    mcpUrl: "https://api.devrev.ai/mcp/v1",
    icon: Globe,
  },
  {
    name: "Digits",
    mcpUrl: "https://api.digits.com/mcp",
    icon: Globe,
  },
  {
    name: "DocuSeal",
    mcpUrl: "https://docuseal.com/mcp",
    icon: Globe,
  },
  {
    name: "DocuSign",
    mcpUrl: "https://mcp.docusign.com/mcp",
    icon: Globe,
  },
  {
    name: "Dovetail",
    mcpUrl: "https://dovetail.com/api/mcp",
    icon: Globe,
  },
  {
    name: "Egnyte",
    mcpUrl: "https://mcp-server.egnyte.com/mcp",
    icon: Globe,
  },
  {
    name: "Enterpret Wisdom",
    mcpUrl: "https://wisdom-api.enterpret.com/server/mcp",
    icon: Globe,
  },
  {
    name: "Exa",
    mcpUrl: "https://mcp.exa.ai/mcp",
    icon: Globe,
  },
  {
    name: "FactSet AI-Ready Data",
    mcpUrl: "https://mcp.factset.com/content/v1",
    icon: Globe,
  },
  {
    name: "Fathom",
    mcpUrl: "https://api.fathom.ai/mcp",
    icon: Globe,
  },
  {
    name: "Fellow.ai",
    mcpUrl: "https://fellow.app/mcp",
    icon: Globe,
  },
  {
    name: "Fever Event Discovery",
    mcpUrl: "https://data-search.apigw.feverup.com/mcp",
    icon: Globe,
  },
  {
    name: "Figma",
    mcpUrl: "https://mcp.figma.com/mcp",
    icon: Figma,
  },
  {
    name: "Fireflies",
    mcpUrl: "https://api.fireflies.ai/mcp",
    icon: Globe,
  },
  {
    name: "Fiscal.ai",
    mcpUrl: "https://api.fiscal.ai/mcp/sse",
    icon: Globe,
  },
  {
    name: "G2",
    mcpUrl: "https://mcp.g2.com/mcp",
    icon: Globe,
  },
  {
    name: "Gainsight Staircase AI",
    mcpUrl: "https://mcp.staircase.ai/mcp",
    icon: Globe,
  },
  {
    name: "Gamma",
    mcpUrl: "https://mcp.gamma.app/mcp",
    icon: Globe,
  },
  {
    name: "GitHub",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    icon: GitHubDark,
  },
  {
    name: "Gmail",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    icon: Gmail,
  },
  {
    name: "Google Calendar",
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    icon: GoogleCalendar,
  },
  {
    name: "Google Cloud BigQuery",
    mcpUrl: "https://bigquery.googleapis.com/mcp",
    icon: GoogleCloud,
  },
  {
    name: "Google Compute Engine",
    mcpUrl: "https://compute.googleapis.com/mcp",
    icon: GoogleCloud,
  },
  {
    name: "Google Drive",
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
    icon: GoogleDrive,
  },
  {
    name: "GovTribe",
    mcpUrl: "https://govtribe.com/mcp",
    icon: Globe,
  },
  {
    name: "Granola",
    mcpUrl: "https://mcp.granola.ai/mcp",
    icon: GranolaDark,
  },
  {
    name: "Guru",
    mcpUrl: "https://mcp.api.getguru.com/mcp",
    icon: Globe,
  },
  {
    name: "Gusto",
    mcpUrl: "https://mcp.api.gusto.com/anthropic",
    icon: Globe,
  },
  {
    name: "Harmonic",
    mcpUrl: "https://mcp.api.harmonic.ai",
    icon: Globe,
  },
  {
    name: "Harvey",
    mcpUrl: "https://api.harvey.ai/hosted_mcp/mcp",
    icon: Globe,
  },
  {
    name: "Honeycomb",
    mcpUrl: "https://mcp.honeycomb.io/mcp",
    icon: Globe,
  },
  {
    name: "HubSpot",
    mcpUrl: "https://mcp.hubspot.com/anthropic",
    icon: Globe,
  },
  {
    name: "Hugging Face",
    mcpUrl: "https://huggingface.co/mcp?login&gradio=none",
    icon: HuggingFace,
  },
  {
    name: "incident.io",
    mcpUrl: "https://mcp.incident.io/mcp",
    icon: Globe,
  },
  {
    name: "Indeed",
    mcpUrl: "https://mcp.indeed.com/claude/mcp",
    icon: Globe,
  },
  {
    name: "Instacart",
    mcpUrl: "https://fig-mcp.instacart.com/mcp",
    icon: Globe,
  },
  {
    name: "Intercom",
    mcpUrl: "https://mcp.intercom.com/mcp",
    icon: Globe,
  },
  {
    name: "Intuit Credit Karma",
    mcpUrl: "https://anthropic.mcp.creditkarma.com/mcp",
    icon: Globe,
  },
  {
    name: "Intuit Mailchimp",
    mcpUrl: "https://ai-inc.mailchimp.com/claude/mcp/v2",
    icon: Globe,
  },
  {
    name: "Intuit TurboTax",
    mcpUrl: "https://ai-inc.turbotax.intuit.com/358A1C1B-F73B-46A7-B130-4B14916E6843/v1/mcp",
    icon: Globe,
  },
  {
    name: "Jam",
    mcpUrl: "https://mcp.jam.dev/mcp",
    icon: Globe,
  },
  {
    name: "Jentic",
    mcpUrl: "https://api.jentic.com/mcp",
    icon: Globe,
  },
  {
    name: "Jotform",
    mcpUrl: "https://mcp.jotform.com/mcp-app",
    icon: Globe,
  },
  {
    name: "Ketryx",
    mcpUrl: "https://app.ketryx.com/api/mcp",
    icon: Globe,
  },
  {
    name: "Klaviyo",
    mcpUrl: "https://mcp.klaviyo.com/mcp?include-mcp-app=true",
    icon: Globe,
  },
  {
    name: "Krisp",
    mcpUrl: "https://mcp.krisp.ai/mcp",
    icon: Globe,
  },
  {
    name: "LegalZoom",
    mcpUrl: "https://www.legalzoom.com/mcp/claude/v1",
    icon: Globe,
  },
  {
    name: "LILT",
    mcpUrl: "https://mcp.lilt.com/mcp",
    icon: Globe,
  },
  {
    name: "Linear",
    mcpUrl: "https://mcp.linear.app/mcp",
    icon: Linear,
  },
  {
    name: "Local Falcon",
    mcpUrl: "https://mcp.localfalcon.com",
    icon: Globe,
  },
  {
    name: "Lorikeet",
    mcpUrl: "https://api.lorikeetcx.ai/v1/mcp",
    icon: Globe,
  },
  {
    name: "LSEG",
    mcpUrl: "https://api.analytics.lseg.com/lfa/mcp/server-cl",
    icon: Globe,
  },
  {
    name: "Lucid",
    mcpUrl: "https://mcp.lucid.app/mcp",
    icon: Globe,
  },
  {
    name: "Lumin",
    mcpUrl: "https://mcp.luminpdf.com/mcp",
    icon: Globe,
  },
  {
    name: "LunarCrush",
    mcpUrl: "https://lunarcrush.ai/mcp",
    icon: Globe,
  },
  {
    name: "Lusha",
    mcpUrl: "https://mcp.lusha.com/",
    icon: Globe,
  },
  {
    name: "Magic Patterns",
    mcpUrl: "https://mcp.magicpatterns.com/mcp",
    icon: Globe,
  },
  {
    name: "MailerLite",
    mcpUrl: "https://mcp.mailerlite.com/mcp",
    icon: Globe,
  },
  {
    name: "Make",
    mcpUrl: "https://mcp.make.com",
    icon: Globe,
  },
  {
    name: "Medidata",
    mcpUrl: "https://mcp.imedidata.com/mcp",
    icon: Globe,
  },
  {
    name: "Melon",
    mcpUrl: "https://mcp.melon.com/mcp/",
    icon: Globe,
  },
  {
    name: "Mem",
    mcpUrl: "https://mcp.mem.ai/mcp",
    icon: Globe,
  },
  {
    name: "Mercury",
    mcpUrl: "https://mcp.mercury.com/mcp",
    icon: Globe,
  },
  {
    name: "Metaview",
    mcpUrl: "https://mcp.metaview.ai/mcp",
    icon: Globe,
  },
  {
    name: "Microsoft 365",
    mcpUrl: "https://microsoft365.mcp.claude.com/mcp",
    icon: Microsoft,
  },
  {
    name: "Miro",
    mcpUrl: "https://mcp.miro.com/",
    icon: Globe,
  },
  {
    name: "Mixpanel",
    mcpUrl: "https://mcp.mixpanel.com/mcp",
    icon: Globe,
  },
  {
    name: "monday.com",
    mcpUrl: "https://mcp.monday.com/mcp",
    icon: Globe,
  },
  {
    name: "Moody's",
    mcpUrl: "https://api.moodys.com/genai-ready-data/m1/mcp",
    icon: Globe,
  },
  {
    name: "Morningstar",
    mcpUrl: "https://mcp.morningstar.com/mcp",
    icon: Globe,
  },
  {
    name: "MotherDuck",
    mcpUrl: "https://api.motherduck.com/mcp",
    icon: Globe,
  },
  {
    name: "MSCI",
    mcpUrl: "https://mcp.msci.com/mcp/v1.0/mcp",
    icon: Globe,
  },
  {
    name: "MT Newswires",
    mcpUrl: "https://vast-mcp.blueskyapi.com/mcp",
    icon: Globe,
  },
  {
    name: "Netlify",
    mcpUrl: "https://netlify-mcp.netlify.app/mcp",
    icon: Netlify,
  },
  {
    name: "Notion",
    mcpUrl: "https://mcp.notion.com/mcp",
    icon: Notion,
  },
  {
    name: "Omni Analytics",
    mcpUrl: "https://callbacks.omniapp.co/callback/mcp",
    icon: Globe,
  },
  {
    name: "Orion by Gravity",
    mcpUrl: "https://g.runorion.com/mcp",
    icon: Globe,
  },
  {
    name: "Outreach",
    mcpUrl: "https://api.outreach.io/mcp/",
    icon: Globe,
  },
  {
    name: "PagerDuty",
    mcpUrl: "https://mcp.pagerduty.com/mcp",
    icon: Globe,
  },
  {
    name: "PayPal",
    mcpUrl: "https://mcp.paypal.com/mcp",
    icon: PayPal,
  },
  {
    name: "PDF Viewer",
    mcpUrl: "https://example-server.modelcontextprotocol.io/pdf/mcp",
    icon: PDF,
  },
  {
    name: "PitchBook Premium",
    mcpUrl: "https://premium.mcp.pitchbook.com/mcp",
    icon: Globe,
  },
  {
    name: "Plaid Developer Tools",
    mcpUrl: "https://api.dashboard.plaid.com/mcp/sse",
    icon: Globe,
  },
  {
    name: "PlanetScale",
    mcpUrl: "https://mcp.pscale.dev/mcp/planetscale",
    icon: PlanetScaleDark,
  },
  {
    name: "Play Sheet Music",
    mcpUrl: "https://example-server.modelcontextprotocol.io/sheet-music/mcp",
    icon: Globe,
  },
  {
    name: "PlayMCP",
    mcpUrl: "https://playmcp.kakao.com/mcp",
    icon: Globe,
  },
  {
    name: "PostHog",
    mcpUrl: "https://mcp.posthog.com/mcp",
    icon: PostHog,
  },
  {
    name: "Postman",
    mcpUrl: "https://mcp.postman.com/minimal",
    icon: Postman,
  },
  {
    name: "Process Street",
    mcpUrl: "https://mcp.process.st",
    icon: Globe,
  },
  {
    name: "Pylon",
    mcpUrl: "https://mcp.usepylon.com/",
    icon: Globe,
  },
  {
    name: "Quartr",
    mcpUrl: "https://mcp.quartr.com/mcp",
    icon: Globe,
  },
  {
    name: "Ramp",
    mcpUrl: "https://ramp-mcp-remote.ramp.com/mcp",
    icon: Globe,
  },
  {
    name: "Razorpay",
    mcpUrl: "https://mcp.razorpay.com/mcp",
    icon: Globe,
  },
  {
    name: "Resy",
    mcpUrl: "https://apigw.americanexpress.com/dining/v1/mcp",
    icon: Globe,
  },
  {
    name: "Rillet",
    mcpUrl: "https://api.rillet.com/mcp",
    icon: Globe,
  },
  {
    name: "S&P Global",
    mcpUrl: "https://kfinance.kensho.com/integrations/mcp",
    icon: Globe,
  },
  {
    name: "Sanity",
    mcpUrl: "https://mcp.sanity.io",
    icon: SanityDark,
  },
  {
    name: "Scholar Gateway",
    mcpUrl: "https://connector.scholargateway.ai/mcp",
    icon: Globe,
  },
  {
    name: "Sentry",
    mcpUrl: "https://mcp.sentry.dev/mcp",
    icon: Sentry,
  },
  {
    name: "SignNow",
    mcpUrl: "https://mcp-server.signnow.com/mcp",
    icon: Globe,
  },
  {
    name: "Similarweb",
    mcpUrl: "https://mcp.similarweb.com",
    icon: Globe,
  },
  {
    name: "Slack",
    mcpUrl: "https://mcp.slack.com/mcp",
    icon: Slack,
  },
  {
    name: "Sprouts Data Intelligence",
    mcpUrl: "https://sprouts-mcp-server.kartikay-dhar.workers.dev",
    icon: Globe,
  },
  {
    name: "Square",
    mcpUrl: "https://mcp.squareup.com/sse",
    icon: Globe,
  },
  {
    name: "Stripe",
    mcpUrl: "https://mcp.stripe.com",
    icon: Stripe,
  },
  {
    name: "Stytch",
    mcpUrl: "https://mcp.stytch.dev/mcp",
    icon: Globe,
  },
  {
    name: "Supabase",
    mcpUrl: "https://mcp.supabase.com/mcp",
    icon: Supabase,
  },
  {
    name: "Superhuman Mail",
    mcpUrl: "https://mcp.mail.superhuman.com/mcp",
    icon: Globe,
  },
  {
    name: "Supermetrics Marketing Analytics",
    mcpUrl: "https://mcp.supermetrics.com/mcp",
    icon: Globe,
  },
  {
    name: "Sybill",
    mcpUrl: "https://mcp.sybill.ai/mcp",
    icon: Globe,
  },
  {
    name: "Synapse.org",
    mcpUrl: "https://mcp.synapse.org/mcp",
    icon: Globe,
  },
  {
    name: "Tango",
    mcpUrl: "https://govcon.dev/mcp",
    icon: Globe,
  },
  {
    name: "Tavily",
    mcpUrl: "https://mcp.tavily.com/mcp",
    icon: Globe,
  },
  {
    name: "Three.js 3D Viewer",
    mcpUrl: "https://example-server.modelcontextprotocol.io/threejs/mcp",
    icon: ThreejsDark,
  },
  {
    name: "Ticket Tailor",
    mcpUrl: "https://mcp.tickettailor.ai/mcp",
    icon: Globe,
  },
  {
    name: "Tropic",
    mcpUrl: "https://app.tropicapp.io/mcp",
    icon: Globe,
  },
  {
    name: "Udemy Business",
    mcpUrl: "https://api.udemy.com/mcp",
    icon: UdemyDark,
  },
  {
    name: "Unthread",
    mcpUrl: "https://app.unthread.io/api/mcp",
    icon: Globe,
  },
  {
    name: "Vercel",
    mcpUrl: "https://mcp.vercel.com/",
    icon: VercelDark,
  },
  {
    name: "Vibe Prospecting",
    mcpUrl: "https://vibeprospecting.explorium.ai/mcp",
    icon: Globe,
  },
  {
    name: "Webflow",
    mcpUrl: "https://mcp.webflow.com/mcp",
    icon: Webflow,
  },
  {
    name: "Windsor.ai",
    mcpUrl: "https://mcp.windsor.ai",
    icon: Globe,
  },
  {
    name: "Wix",
    mcpUrl: "https://mcp.wix.com/mcp",
    icon: Globe,
  },
  {
    name: "WordPress.com",
    mcpUrl: "https://public-api.wordpress.com/wpcom/v2/mcp/v1",
    icon: WordPress,
  },
  {
    name: "Zapier",
    mcpUrl: "https://mcp.zapier.com/api/v1/connect",
    icon: Globe,
  },
  {
    name: "Zocks",
    mcpUrl: "https://mcp.zocks.io/v1/mcp",
    icon: Globe,
  },
  {
    name: "Zoho Books",
    mcpUrl: "https://claude-zohobooks.zohomcp.com/mcp/message",
    icon: Globe,
  },
  {
    name: "Zoho CRM",
    mcpUrl: "https://claude-zohocrm.zohomcp.com/mcp/message",
    icon: Globe,
  },
  {
    name: "Zoho Desk",
    mcpUrl: "https://claude-zohodesk.zohomcp.com/mcp/message",
    icon: Globe,
  },
  {
    name: "Zoho Projects",
    mcpUrl: "https://claude-zohoprojects.zohomcp.com/mcp/message",
    icon: Globe,
  },
  {
    name: "Zoom",
    mcpUrl: "https://mcp.zoom.us/mcp/zoom/streamable",
    icon: Zoom,
  },
  {
    name: "ZoomInfo",
    mcpUrl: "https://mcp.zoominfo.com/mcp",
    icon: Globe,
  },
] as const satisfies readonly McpServer[]

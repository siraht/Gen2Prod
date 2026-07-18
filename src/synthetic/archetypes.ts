import type { ComponentContract, InteractionContract, TokenRegistry } from "../schemas/normal-form.ts";
import type { CanonicalNode, CanonicalPageSpec } from "./types.ts";

type NodeInput = Omit<CanonicalNode, "attributes" | "styles" | "children"> & {
  attributes?: Record<string, string>;
  styles?: Record<string, string>;
  children?: CanonicalNode[];
};

function node(input: NodeInput): CanonicalNode {
  return { attributes: {}, styles: {}, children: [], ...input };
}

const tokens: TokenRegistry = {
  schemaVersion: "dtcg-2025-10+gen2prod-0.1.0",
  conformsTo: ["DTCG Format Module 2025.10", "DTCG Color Module 2025.10"],
  adapterSchema: "gen2prod-token-adapter-0.1.0",
  tokens: [
    { id: "spacing.s", name: "spacing.s", type: "dimension", category: "spacing", value: { value: 0.75, unit: "rem" }, runtimeVariable: "--space-s", runtimeExpression: "var(--space-s)", semanticRole: "compact-spacing", allowedProperties: ["gap", "padding", "margin"], source: "fixture", status: "active", sampledValues: { "default@1280": "12px" } },
    { id: "spacing.m", name: "spacing.m", type: "dimension", category: "spacing", value: { value: 1, unit: "rem" }, runtimeVariable: "--space-m", runtimeExpression: "var(--space-m)", semanticRole: "content-spacing", allowedProperties: ["gap", "padding", "margin"], source: "fixture", status: "active", sampledValues: { "default@1280": "16px" } },
    { id: "spacing.l", name: "spacing.l", type: "dimension", category: "spacing", value: { value: 2, unit: "rem" }, runtimeVariable: "--space-l", runtimeExpression: "var(--space-l)", semanticRole: "component-spacing", allowedProperties: ["gap", "padding", "margin"], source: "fixture", status: "active", sampledValues: { "default@1280": "32px" } },
    { id: "spacing.section", name: "spacing.section", type: "dimension", category: "section-spacing", value: { value: 5, unit: "rem" }, runtimeVariable: "--section-space", runtimeExpression: "var(--section-space)", semanticRole: "section-block-padding", allowedProperties: ["padding-block"], source: "fixture", status: "active", sampledValues: { "default@1280": "80px" } },
    { id: "color.text", name: "color.text", type: "color", category: "color", value: { colorSpace: "srgb", components: [0.08, 0.1, 0.16], alpha: 1 }, runtimeVariable: "--text-color", runtimeExpression: "var(--text-color)", semanticRole: "body-text", allowedProperties: ["color"], source: "fixture", status: "active", sampledValues: { "default@1280": "#141a29" } },
    { id: "color.surface", name: "color.surface", type: "color", category: "color", value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1 }, runtimeVariable: "--surface", runtimeExpression: "var(--surface)", semanticRole: "surface", allowedProperties: ["background-color"], source: "fixture", status: "active", sampledValues: { "default@1280": "#ffffff" } },
    { id: "color.canvas", name: "color.canvas", type: "color", category: "color", value: { colorSpace: "srgb", components: [0.96, 0.97, 0.99], alpha: 1 }, runtimeVariable: "--canvas", runtimeExpression: "var(--canvas)", semanticRole: "page-canvas", allowedProperties: ["background-color"], source: "fixture", status: "active", sampledValues: { "default@1280": "#f5f7fc" } },
    { id: "color.primary", name: "color.primary", type: "color", category: "color", value: { colorSpace: "srgb", components: [0.12, 0.3, 0.8], alpha: 1 }, runtimeVariable: "--primary", runtimeExpression: "var(--primary)", semanticRole: "primary-action", allowedProperties: ["color", "background-color", "outline-color"], source: "fixture", status: "active", sampledValues: { "default@1280": "#1f4dcc" } },
    { id: "color.on-primary", name: "color.on-primary", type: "color", category: "color", value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1 }, runtimeVariable: "--on-primary", runtimeExpression: "var(--on-primary)", semanticRole: "on-primary-text", allowedProperties: ["color"], source: "fixture", status: "active", sampledValues: { "default@1280": "#ffffff" } },
    { id: "radius.m", name: "radius.m", type: "dimension", category: "radius", value: { value: 0.75, unit: "rem" }, runtimeVariable: "--radius-m", runtimeExpression: "var(--radius-m)", semanticRole: "component-radius", allowedProperties: ["border-radius"], source: "fixture", status: "active", sampledValues: { "default@1280": "12px" } },
    { id: "sizing.content", name: "sizing.content", type: "dimension", category: "content-width", value: { value: 72, unit: "rem" }, runtimeVariable: "--content-width", runtimeExpression: "var(--content-width)", semanticRole: "page-content-width", allowedProperties: ["max-inline-size"], source: "fixture", status: "active", sampledValues: { "default@1280": "1152px" } },
    { id: "typography.h1", name: "typography.h1", type: "dimension", category: "typography", value: { value: 3, unit: "rem" }, runtimeVariable: "--h1", runtimeExpression: "var(--h1)", semanticRole: "page-title", allowedProperties: ["font-size"], source: "fixture", status: "active", sampledValues: { "default@1280": "48px" } },
    { id: "typography.h2", name: "typography.h2", type: "dimension", category: "typography", value: { value: 2, unit: "rem" }, runtimeVariable: "--h2", runtimeExpression: "var(--h2)", semanticRole: "section-title", allowedProperties: ["font-size"], source: "fixture", status: "active", sampledValues: { "default@1280": "32px" } },
    { id: "typography.body.large", name: "typography.body.large", type: "dimension", category: "typography", value: { value: 1.125, unit: "rem" }, runtimeVariable: "--text-l", runtimeExpression: "var(--text-l)", semanticRole: "large-body-copy", allowedProperties: ["font-size"], source: "fixture", status: "active", sampledValues: { "default@1280": "1.125rem" } },
    { id: "typography.card.title", name: "typography.card.title", type: "dimension", category: "typography", value: { value: 1.25, unit: "rem" }, runtimeVariable: "--card-title-size", runtimeExpression: "var(--card-title-size)", semanticRole: "card-title", allowedProperties: ["font-size"], source: "fixture", status: "active", sampledValues: { "default@1280": "1.25rem" } },
    { id: "typography.heading.tight", name: "typography.heading.tight", type: "number", category: "typography", value: 1.05, runtimeVariable: "--heading-line-height-tight", runtimeExpression: "var(--heading-line-height-tight)", semanticRole: "tight-heading-line-height", allowedProperties: ["line-height"], source: "fixture", status: "active", sampledValues: { "default@1280": "1.05" } },
    { id: "typography.heading.default", name: "typography.heading.default", type: "number", category: "typography", value: 1.15, runtimeVariable: "--heading-line-height", runtimeExpression: "var(--heading-line-height)", semanticRole: "heading-line-height", allowedProperties: ["line-height"], source: "fixture", status: "active", sampledValues: { "default@1280": "1.15" } },
    { id: "typography.family.body", name: "typography.family.body", type: "fontFamily", category: "typography", value: "system-ui, sans-serif", runtimeVariable: "--body-font-family", runtimeExpression: "var(--body-font-family)", semanticRole: "body-font-family", allowedProperties: ["font-family"], source: "fixture", status: "active", sampledValues: { "default@1280": "system-ui, sans-serif" } },
    { id: "typography.weight.bold", name: "typography.weight.bold", type: "fontWeight", category: "typography", value: 700, runtimeVariable: "--font-weight-bold", runtimeExpression: "var(--font-weight-bold)", semanticRole: "bold-text", allowedProperties: ["font-weight"], source: "fixture", status: "active", sampledValues: { "default@1280": "700" } },
  ],
};

const sharedStyles = {
  page: { "font-family": "system-ui, sans-serif", color: "var(--text-color)", "background-color": "var(--canvas)", margin: "0" },
  section: { "padding-block": "var(--section-space)", "padding-inline": "var(--space-m)" },
  inner: { "max-inline-size": "var(--content-width)", "margin-inline": "auto" },
  title: { "font-size": "var(--h1)", "line-height": "1.05", margin: "0" },
  sectionTitle: { "font-size": "var(--h2)", "line-height": "1.15", margin: "0" },
  button: { display: "inline-flex", padding: "var(--space-s) var(--space-m)", "border-radius": "var(--radius-m)", "background-color": "var(--primary)", color: "var(--on-primary)", "text-decoration": "none" },
  card: { padding: "var(--space-l)", "border-radius": "var(--radius-m)", "background-color": "var(--surface)" },
};

function contract(name: string, type: "component" | "section", elements: string[], variants: string[] = []): ComponentContract {
  return {
    name,
    type,
    description: `${name} fixture contract`,
    props: { title: { type: "string", required: true } },
    variants,
    states: ["default", "focus-visible"],
    slots: elements,
    bem: { block: name, elements, modifiers: variants },
  };
}

function base(id: string, archetype: CanonicalPageSpec["archetype"], root: CanonicalNode, components: ComponentContract[], interactions: InteractionContract[] = []): CanonicalPageSpec {
  return {
    schemaVersion: "0.1.0",
    id,
    archetype,
    domain: "synthetic-productivity-software",
    intent: { pageGoal: `Demonstrate ${archetype}`, audience: "small product teams", conversionGoal: "start a trial", seoIntent: `${archetype} productivity software` },
    components,
    tokens,
    root,
    interactions,
    viewports: [360, 768, 1280, 1440],
  };
}

function page(children: CanonicalNode[]): CanonicalNode {
  return node({ nodeId: "page", tag: "body", role: "document", classes: ["page"], styles: sharedStyles.page, children: [node({ nodeId: "main", tag: "main", role: "main", classes: [], children })] });
}

export function createArchetypes(): CanonicalPageSpec[] {
  const buttonContract = contract("button", "component", ["label"], ["primary", "secondary"]);
  const hero = base("hero-cta", "hero-cta", page([
    node({ nodeId: "hero", tag: "section", role: "primary-intro", classes: ["hero", "hero--split"], attributes: { "aria-labelledby": "hero-title" }, styles: sharedStyles.section, children: [
      node({ nodeId: "hero-inner", tag: "div", role: "layout-container", classes: ["hero__inner"], styles: { ...sharedStyles.inner, display: "grid", gap: "var(--space-l)" }, children: [
        node({ nodeId: "hero-content", tag: "div", role: "content-stack", classes: ["hero__content"], styles: { display: "grid", gap: "var(--space-m)" }, children: [
          node({ nodeId: "hero-title", tag: "h1", role: "primary-heading", classes: ["hero__title"], attributes: { id: "hero-title" }, text: "Ship a calmer workday", styles: sharedStyles.title }),
          node({ nodeId: "hero-lede", tag: "p", role: "supporting-copy", classes: ["hero__lede"], text: "Plan, focus, and finish meaningful work without the busywork.", styles: { margin: "0", "font-size": "1.125rem" } }),
          node({ nodeId: "hero-actions", tag: "div", role: "cta-group", classes: ["hero__actions"], styles: { display: "flex", gap: "var(--space-s)" }, children: [
            node({ nodeId: "hero-cta", tag: "a", role: "primary-cta", classes: ["button", "button--primary"], attributes: { href: "/start" }, text: "Start free", styles: sharedStyles.button }),
          ] }),
        ] }),
        node({ nodeId: "hero-media", tag: "div", role: "visual-proof", classes: ["hero__media"], styles: sharedStyles.card, children: [
          node({ nodeId: "hero-image", tag: "img", role: "meaningful-image", classes: ["hero__image"], attributes: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='400'%3E%3Crect width='640' height='400' fill='%23dbe5ff'/%3E%3C/svg%3E", alt: "Product dashboard with a prioritized task list", width: "640", height: "400" }, styles: { display: "block", "inline-size": "100%", "border-radius": "var(--radius-m)" } }),
        ] }),
      ] }),
    ] }),
  ]), [contract("hero", "section", ["inner", "content", "title", "lede", "actions", "media", "image"], ["split"]), buttonContract], [{ component: "button", nodeId: "hero-cta", kind: "link", keyboard: ["Enter activates navigation"], focusManagement: "native link focus", stateAttributes: [], reducedMotion: "no motion" }]);

  const featureItems = ["Clear priorities", "Protected focus", "Visible progress"].map((title, index) => node({ nodeId: `feature-${index + 1}`, tag: "li", role: "feature-item", classes: ["feature-grid__item", "feature-card"], styles: sharedStyles.card, children: [
    node({ nodeId: `feature-${index + 1}-title`, tag: "h2", role: "card-heading", classes: ["feature-card__title"], text: title, styles: { margin: "0", "font-size": "1.25rem" } }),
    node({ nodeId: `feature-${index + 1}-text`, tag: "p", role: "card-copy", classes: ["feature-card__text"], text: "A consistent system keeps the team moving.", styles: { margin: "var(--space-s) 0 0" } }),
  ] }));
  const features = base("feature-grid", "feature-grid", page([node({ nodeId: "features", tag: "section", role: "product-features", classes: ["feature-grid"], attributes: { "aria-labelledby": "features-title" }, styles: sharedStyles.section, children: [
    node({ nodeId: "features-inner", tag: "div", role: "layout-container", classes: ["feature-grid__inner"], styles: sharedStyles.inner, children: [
      node({ nodeId: "features-title", tag: "h1", role: "primary-heading", classes: ["feature-grid__title"], attributes: { id: "features-title" }, text: "Everything needed to move forward", styles: sharedStyles.sectionTitle }),
      node({ nodeId: "features-list", tag: "ul", role: "feature-list", classes: ["feature-grid__list"], styles: { display: "grid", gap: "var(--space-m)", "grid-template-columns": "repeat(3, minmax(0, 1fr))", "list-style": "none", padding: "0" }, children: featureItems }),
    ] }),
  ] })]), [contract("feature-grid", "section", ["inner", "title", "list", "item"]), contract("feature-card", "component", ["title", "text"])]);

  const priceCards = ["Starter", "Team", "Scale"].map((title, index) => node({ nodeId: `plan-${index}`, tag: "li", role: "pricing-plan", classes: ["pricing__item", "pricing-card", ...(index === 1 ? ["pricing-card--featured"] : [])], styles: sharedStyles.card, children: [
    node({ nodeId: `plan-${index}-title`, tag: "h2", role: "plan-heading", classes: ["pricing-card__title"], text: title, styles: { margin: "0" } }),
    node({ nodeId: `plan-${index}-price`, tag: "p", role: "plan-price", classes: ["pricing-card__price"], text: `$${[9, 24, 79][index]}/month`, styles: { "font-size": "var(--h2)" } }),
    node({ nodeId: `plan-${index}-cta`, tag: "a", role: "plan-cta", classes: ["button", "button--primary"], attributes: { href: `/start?plan=${title.toLowerCase()}` }, text: "Choose plan", styles: sharedStyles.button }),
  ] }));
  const pricing = base("pricing", "pricing", page([node({ nodeId: "pricing", tag: "section", role: "pricing", classes: ["pricing"], attributes: { "aria-labelledby": "pricing-title" }, styles: sharedStyles.section, children: [node({ nodeId: "pricing-inner", tag: "div", role: "layout-container", classes: ["pricing__inner"], styles: sharedStyles.inner, children: [node({ nodeId: "pricing-title", tag: "h1", role: "primary-heading", classes: ["pricing__title"], attributes: { id: "pricing-title" }, text: "Simple pricing", styles: sharedStyles.title }), node({ nodeId: "pricing-list", tag: "ul", role: "plan-list", classes: ["pricing__list"], styles: { display: "grid", gap: "var(--space-m)", "grid-template-columns": "repeat(3, minmax(0, 1fr))", "list-style": "none", padding: "0" }, children: priceCards })] })] })]), [contract("pricing", "section", ["inner", "title", "list", "item"]), contract("pricing-card", "component", ["title", "price", "action"], ["featured"]), buttonContract]);

  const faq = base("faq", "faq", page([node({ nodeId: "faq", tag: "section", role: "frequently-asked-questions", classes: ["faq"], attributes: { "aria-labelledby": "faq-title" }, styles: sharedStyles.section, children: [node({ nodeId: "faq-inner", tag: "div", role: "layout-container", classes: ["faq__inner"], styles: sharedStyles.inner, children: [node({ nodeId: "faq-title", tag: "h1", role: "primary-heading", classes: ["faq__title"], attributes: { id: "faq-title" }, text: "Questions, answered", styles: sharedStyles.title }), ...["Can I cancel anytime?", "Does it work offline?"].map((question, index) => node({ nodeId: `faq-item-${index}`, tag: "details", role: "disclosure", classes: ["faq__item"], styles: sharedStyles.card, children: [node({ nodeId: `faq-summary-${index}`, tag: "summary", role: "disclosure-button", classes: ["faq__question"], text: question, styles: { cursor: "pointer", "font-weight": "700" } }), node({ nodeId: `faq-answer-${index}`, tag: "p", role: "disclosure-panel", classes: ["faq__answer"], text: "Yes. Your data remains available on your terms.", styles: { margin: "var(--space-s) 0 0" } })] }))] })] })]), [contract("faq", "section", ["inner", "title", "item", "question", "answer"])], [{ component: "faq", nodeId: "faq-item-0", kind: "disclosure", keyboard: ["Enter or Space toggles"], focusManagement: "focus remains on summary", stateAttributes: ["open"], reducedMotion: "no motion required" }]);

  const testimonial = base("testimonial", "testimonial", page([node({ nodeId: "testimonial", tag: "section", role: "customer-proof", classes: ["testimonial"], attributes: { "aria-labelledby": "testimonial-title" }, styles: sharedStyles.section, children: [node({ nodeId: "testimonial-inner", tag: "div", role: "layout-container", classes: ["testimonial__inner"], styles: sharedStyles.inner, children: [node({ nodeId: "testimonial-title", tag: "h1", role: "primary-heading", classes: ["testimonial__title"], attributes: { id: "testimonial-title" }, text: "Loved by focused teams", styles: sharedStyles.title }), node({ nodeId: "quote", tag: "figure", role: "testimonial-quote", classes: ["testimonial-card"], styles: sharedStyles.card, children: [node({ nodeId: "quote-text", tag: "blockquote", role: "quote", classes: ["testimonial-card__quote"], text: "We finally know what deserves attention each morning.", styles: { margin: "0", "font-size": "1.25rem" } }), node({ nodeId: "quote-attribution", tag: "figcaption", role: "attribution", classes: ["testimonial-card__attribution"], text: "Mina Chen, Northstar", styles: { "margin-block-start": "var(--space-s)" } })] })] })] })]), [contract("testimonial", "section", ["inner", "title"]), contract("testimonial-card", "component", ["quote", "attribution"])]);

  const navigation = base("navigation", "navigation", page([node({ nodeId: "site-header", tag: "header", role: "site-header", classes: ["site-header"], styles: { padding: "var(--space-m)", "background-color": "var(--surface)" }, children: [node({ nodeId: "primary-nav", tag: "nav", role: "primary-navigation", classes: ["site-header__nav"], attributes: { "aria-label": "Primary" }, styles: sharedStyles.inner, children: [node({ nodeId: "nav-list", tag: "ul", role: "navigation-list", classes: ["site-header__list"], styles: { display: "flex", gap: "var(--space-m)", "list-style": "none", padding: "0", margin: "0" }, children: ["Product", "Pricing", "About"].map((label, index) => node({ nodeId: `nav-item-${index}`, tag: "li", role: "navigation-item", classes: ["site-header__item"], children: [node({ nodeId: `nav-link-${index}`, tag: "a", role: "navigation-link", classes: ["site-header__link"], attributes: { href: `/${label.toLowerCase()}` }, text: label, styles: { color: "var(--text-color)" } })] })) })] })] }), node({ nodeId: "navigation-title", tag: "h1", role: "primary-heading", classes: ["page__title"], text: "Navigation", styles: sharedStyles.title })]), [contract("site-header", "section", ["nav", "list", "item", "link"])], [{ component: "site-header", nodeId: "primary-nav", kind: "navigation", keyboard: ["Tab reaches links", "Enter navigates"], focusManagement: "native link focus", stateAttributes: [], reducedMotion: "no motion" }]);

  const form = base("form", "form", page([node({ nodeId: "contact", tag: "section", role: "contact-form-region", classes: ["contact"], attributes: { "aria-labelledby": "contact-title" }, styles: sharedStyles.section, children: [node({ nodeId: "contact-inner", tag: "div", role: "layout-container", classes: ["contact__inner"], styles: sharedStyles.inner, children: [node({ nodeId: "contact-title", tag: "h1", role: "primary-heading", classes: ["contact__title"], attributes: { id: "contact-title" }, text: "Tell us about your team", styles: sharedStyles.title }), node({ nodeId: "contact-form", tag: "form", role: "contact-form", classes: ["contact-form"], attributes: { action: "/contact", method: "post" }, styles: { display: "grid", gap: "var(--space-m)" }, children: [node({ nodeId: "email-label", tag: "label", role: "field-label", classes: ["contact-form__label"], attributes: { for: "email" }, text: "Work email", styles: {} }), node({ nodeId: "email-input", tag: "input", role: "email-field", classes: ["contact-form__input"], attributes: { id: "email", name: "email", type: "email", required: "" }, styles: { padding: "var(--space-s)", "border-radius": "var(--radius-m)" } }), node({ nodeId: "form-submit", tag: "button", role: "submit", classes: ["button", "button--primary"], attributes: { type: "submit" }, text: "Request a demo", styles: sharedStyles.button })] })] })] })]), [contract("contact", "section", ["inner", "title"]), contract("contact-form", "component", ["label", "input"]), buttonContract], [{ component: "contact-form", nodeId: "contact-form", kind: "form", keyboard: ["Tab follows source order", "Enter submits"], focusManagement: "invalid field receives focus", stateAttributes: ["aria-invalid"], reducedMotion: "no motion" }]);

  return [hero, features, pricing, faq, testimonial, navigation, form];
}

/**
 * server/routes/glossary.js
 * GET /api/glossary                    — full glossary (all terms)
 * GET /api/glossary/term-of-the-day    — today's featured term
 * GET /api/glossary/categories         — list of categories with term counts
 * GET /api/glossary/category/:cat      — all terms in a category
 * GET /api/glossary/search?q=yield     — search across terms
 * GET /api/glossary/:slug              — single term by slug
 */
"use strict";

const { Router } = require("express");
const {
  GLOSSARY, BY_SLUG, BY_CATEGORY, CATEGORIES,
  getTermOfTheDay, searchGlossary,
} = require("../engine/glossary");

const router = Router();

function now()            { return new Date().toISOString(); }
function envelope(data)   { return { source: "computed", fetchedAt: now(), stale: false, data }; }

// GET /api/glossary
router.get("/", (req, res) => {
  const { category } = req.query;
  const terms = category
    ? (BY_CATEGORY[category.toLowerCase()] ?? [])
    : GLOSSARY;
  res.json(envelope({ terms, count: terms.length, categories: CATEGORIES }));
});

// GET /api/glossary/term-of-the-day — BEFORE /:slug
router.get("/term-of-the-day", (_req, res) => {
  const term = getTermOfTheDay();
  res.json(envelope({ term }));
});

// GET /api/glossary/categories — BEFORE /:slug
router.get("/categories", (_req, res) => {
  const cats = CATEGORIES.map(cat => ({
    category: cat,
    count:    BY_CATEGORY[cat]?.length ?? 0,
    terms:    BY_CATEGORY[cat]?.map(t => ({ term: t.term, slug: t.slug })) ?? [],
  }));
  res.json(envelope({ categories: cats }));
});

// GET /api/glossary/search?q=yield — BEFORE /:slug
router.get("/search", (req, res) => {
  const q = req.query.q || "";
  if (!q.trim()) return res.json(envelope({ results: [], query: q, count: 0 }));
  const results = searchGlossary(q);
  res.json(envelope({ results, query: q, count: results.length }));
});

// GET /api/glossary/category/:cat — BEFORE /:slug
router.get("/category/:cat", (req, res) => {
  const cat   = req.params.cat.toLowerCase();
  const terms = BY_CATEGORY[cat];
  if (!terms) {
    return res.status(404).json({
      error: `Category not found: ${cat}. Available: ${CATEGORIES.join(", ")}`,
    });
  }
  res.json(envelope({ category: cat, terms, count: terms.length }));
});

// GET /api/glossary/:slug
router.get("/:slug", (req, res) => {
  const term = BY_SLUG[req.params.slug.toLowerCase()];
  if (!term) {
    return res.status(404).json({ error: `Term not found: ${req.params.slug}` });
  }
  res.json(envelope({ term }));
});

module.exports = router;

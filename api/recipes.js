import { RECIPES } from "./_recipes.js";

// Sends the recipe list to the website. Same data the chat AI uses.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  return res.status(200).json(RECIPES);
}

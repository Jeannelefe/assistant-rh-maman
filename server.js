const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// =============================================
// 🔑 COLLE TES CLÉS ICI
// =============================================
const PISTE_CLIENT_ID = process.env.PISTE_CLIENT_ID;
const PISTE_CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// =============================================

// Obtenir un token PISTE
async function getPisteToken() {
  const response = await fetch("https://sandbox-oauth.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: PISTE_CLIENT_ID,
      client_secret: PISTE_CLIENT_SECRET,
      scope: "openid"
    })
  });
  const data = await response.json();
  return data.access_token;
}

// Rechercher dans le Code du travail via Légifrance
async function searchCodeTravail(query, token) {
  const response = await fetch("https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      recherche: {
        champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "EXACTE", valeur: query }] }],
        filtres: [{ facette: "CODE_DATE", valeur: "CODE_EN_VIGUEUR" }, { facette: "NOM_CODE", valeur: "Code du travail" }],
        pageNumber: 1,
        pageSize: 5,
        operateur: "ET",
        typePagination: "DEFAUT"
      },
      fond: "CODE_DATE"
    })
  });
  const data = await response.json();
  return data;
}

// Récupérer le texte complet d'un article
async function getArticle(articleId, token) {
  const response = await fetch(`https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app/consult/getArticle?id=${articleId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const data = await response.json();
  return data;
}

// Route principale - question RH
app.post("/api/question", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Question manquante" });

  try {
    // 1. Obtenir le token PISTE
    const token = await getPisteToken();

    // 2. Rechercher les articles pertinents
    const searchResults = await searchCodeTravail(question, token);

    // 3. Construire le contexte avec les articles trouvés
    let articlesContext = "";
    if (searchResults?.results?.length > 0) {
      for (const result of searchResults.results.slice(0, 3)) {
        if (result.id) {
          const article = await getArticle(result.id, token);
          if (article?.article) {
            articlesContext += `\n[${article.article.num || result.id}] ${article.article.texte || result.titre}\n`;
          }
        }
      }
    }

    // 4. Appeler Claude avec les articles trouvés
    const systemPrompt = `Tu es un assistant juridique spécialisé en droit du travail français pour une direction d'entreprise de 100 salariés dans l'enseignement privé indépendant (CCN EPI, IDCC 2691).

Tu réponds TOUJOURS du point de vue de l'employeur.
Tu te bases UNIQUEMENT sur les articles du Code du travail fournis ci-dessous.
Cite toujours l'article exact. Si les articles fournis ne suffisent pas, dis-le clairement.

Structure ta réponse en 4 blocs :
📋 LA RÈGLE → l'article applicable
✅ CE QUE VOUS POUVEZ FAIRE → les options disponibles  
⏱️ LES DÉLAIS → les délais légaux à respecter
⚠️ LES RISQUES → les conséquences si procédure non respectée

Termine par : "Pour toute décision engageant l'entreprise, consultez votre juriste."

ARTICLES DISPONIBLES :
${articlesContext || "Aucun article trouvé pour cette requête. Indique-le à l'utilisateur et suggère de consulter legifrance.gouv.fr"}`;

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: question }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content?.[0]?.text || "Erreur lors de la génération de la réponse.";

    res.json({ answer, articlesFound: searchResults?.results?.length || 0 });

  } catch (error) {
    console.error("Erreur:", error);
    res.status(500).json({ error: "Une erreur est survenue : " + error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Assistant RH démarré sur le port ${PORT}`));

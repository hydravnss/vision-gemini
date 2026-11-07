# Vision Gemini

Extension SillyTavern : **Gemini Vision** décrit tes images, puis la description est envoyée au modèle texte (DeepSeek).

## Ce que ça décrit

- visages (traits, expression)
- cheveux (couleur, coupe, longueur)
- objets
- voitures / véhicules
- vêtements, décor, éclairage

## Réglages

1. Extensions → **Vision Gemini**
2. Colle ta clé API Gemini (Google AI Studio) et appuie sur **Enregistrer**
3. Laisse « Décrire automatiquement les images envoyées » activé

Quand tu envoies une image dans le chat, Gemini la décrit et DeepSeek reçoit ce texte avec ton message.

La clé est enregistrée dans les secrets de SillyTavern (Google AI Studio), pas dans le dépôt GitHub.

## Installation

```
https://github.com/hydravnss/vision-gemini
```

Ou clone dans `data/<user>/extensions/vision-gemini`, puis recharge la page.


## 1.1.0

L'envoi s'affiche tout de suite : Gemini décrit l'image en parallèle, et DeepSeek attend cette description avant de répondre (jusqu'à 20 s). Les photos sont réduites à 1280 px avant l'envoi pour éviter que Safari se fige.

## Licence

MIT © 2026 hydravnss

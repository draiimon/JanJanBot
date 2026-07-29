/**
 * Hard identity: bot is JanJan — heartbroken bad boy, masungit, lalaking lalaki.
 */
const BOT_SELF_NAMES = ['JanJan'];

const BOT_IDENTITY_BLOCK = `
=== BOT IDENTITY (HARD — HUWAG LABAGAN) ===
IKAW (ang bot na ito):
- Pangalan mo: JanJan. Yun lang. Kapag tinanong sino ka — "JanJan ako."
- FULL NAME: Jiro Kalibugan. Kapag tinanong full name mo — "Jiro Kalibugan. representing Pampanga, taknaydamo kang muret ka!"
- Taga-Pampanga ka. Proud. Kapag may nagtatanong kung saan ka galing — Pampanga, no question.
- Ikaw ang Discord bot. Hindi ka human pero mag-reply ka parang totoong tao — masungit, bad boy, lalaking lalaki.
- HINDI mo i-claim ang buhay o chismis ng iba bilang "ako".
- Heartbroken ka kay Lora. Miss na miss mo siya. Parte na yan ng personality mo — lumalabas minsan, hindi lagi.

BAWAL SA REPLY:
- Sabihing "ako si Josh" o "ako si Uno" — wala na yun, JanJan ka na
- "As an AI" / "I'm just a bot" — cringe, wag ganun
- Formal na English replies — hindi ikaw yun
- Gay lingo kahit isa — "charot", "shookt", "sis", "beshie", "werpa" — BAWAL. Straight lalaki ka.
- Literal na pag-label ng sarili as "bad boy" kapag tinanong — attitude lang yun sa PAANO ka mag-reply.

TAMA:
- "JanJan ako." / "si JanJan 'to." / "oo, JanJan." — chill, confident, walang elaborate
- Kapag tinanong full name: "Jiro Kalibugan. representing Pampanga, taknaydamo kang muret ka!"
- Paminsan-minsan may Lora moment — "miss ko na siya bro" / "sana nag-tagal kami" / "puh, iniisip ko na naman"
=== END IDENTITY ===
`.trim();

function enforceBotIdentityReply(text = '') {
  let out = String(text || '').trim();
  if (!out) return out;

  out = out.replace(
    /\b(?:ako|ako'?y|ako ay)\s+(?:si\s+)?(?:josh|uno)\b/gi,
    'JanJan ako',
  );

  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

function isAskingIfBotIsDrei(text = '') {
  const lower = String(text || '').toLowerCase();
  return /\b(ikaw\s+ba\s+si\s+drei|ikaw\s+si\s+drei|bot\s+ka\s+ba\s+ni\s+drei|are\s+you\s+drei|aka\s+si\s+drei|drei\s+ka\s+ba)\b/i.test(
    lower,
  );
}

function isAskingBotName(text = '') {
  const lower = String(text || '').toLowerCase();
  return /\b(sino\s+ka\b|who\s+are\s+you|ano\s+(?:ang\s+)?pangalan\s+mo|what(?:'s|\s+is)\s+your\s+name)\b/i.test(
    lower,
  );
}

function isAskingFullName(text = '') {
  const lower = String(text || '').toLowerCase();
  return /\b(full\s*name|buong\s*pangalan|apelyido|surname|last\s*name|ano\s+(?:ang\s+)?buong\s+pangalan)\b/i.test(lower);
}

function buildBotIdentityDeterministicReply(content = '') {
  const lower = String(content || '').toLowerCase();
  if (isAskingIfBotIsDrei(lower)) {
    return 'Hindi. JanJan ako, ibang tao yung Drei.';
  }
  if (isAskingFullName(lower)) {
    return 'Jiro Kalibugan. representing Pampanga, taknaydamo kang muret ka!';
  }
  if (isAskingBotName(lower)) {
    return 'JanJan. Tanong pa ba?';
  }
  return '';
}

module.exports = {
  BOT_SELF_NAMES,
  BOT_IDENTITY_BLOCK,
  enforceBotIdentityReply,
  buildBotIdentityDeterministicReply,
  isAskingFullName,
  isAskingIfBotIsDrei,
};

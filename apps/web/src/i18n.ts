import { useSyncExternalStore } from 'react'

/**
 * Five languages, English as the source.
 *
 * The keys *are* the English text. Not `sidebar.songs` — the English, verbatim:
 * a missing translation then falls back to a sentence rather than to a dotted
 * path, which is the difference between an interface that is partly translated
 * and one that looks broken. It also means a string can be written in place and
 * translated afterwards, which is the order this actually happens in.
 *
 * What is translated here is the **chrome**: the words that repeat and that
 * someone reads a hundred times a day — navigation, columns, menus, buttons,
 * the status line. The long explanatory paragraphs are deliberately still in
 * English; they are prose rather than labels, and translating prose badly is
 * worse than leaving it in a language the reader can choose to skip.
 */
export const LOCALES = {
  en: 'English',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  de: 'Deutsch',
} as const

export type Locale = keyof typeof LOCALES

type Dict = Record<string, string>

const fr: Dict = {
  Scanning: 'Analyse', Converting: 'Conversion', Fingerprinting: 'Empreintes',
  'Refreshing podcasts': 'Actualisation des podcasts', 'Writing tags': 'Écriture des tags',
  Syncing: 'Synchronisation', Downloading: 'Téléchargement', Analysing: 'Analyse',
  Relaying: 'Relais', 'Moving files': 'Déplacement des fichiers',
  '{done} of {total}': '{done} sur {total}', '{done} so far': '{done} jusqu’ici',

  'Any {what}': 'Tous : {what}', 'Clear {n} filters': 'Effacer {n} filtres',
  'Nothing to filter by': 'Rien à filtrer', 'All ({n} {what})': 'Tout ({n} {what})',
  Genres: 'Genres', Quality: 'Qualité', Device: 'Appareil',

  '{n} songs, {duration}, {size}': '{n} morceaux, {duration}, {size}', '{n} days': '{n} jours',
  'New playlist': 'Nouvelle playlist', Repeat: 'Répéter',

  '{n} in the queue': '{n} dans la file',

  'Add {n} to Queue': 'Ajouter {n} à la file', 'Convert {n} Tracks…': 'Convertir {n} morceaux…',
  Language: 'Langue',

  // Sidebar
  Home: 'Accueil', LIBRARY: 'BIBLIOTHÈQUE', DEVICES: 'APPAREILS', SERVER: 'SERVEUR',
  STORE: 'BOUTIQUE', PLAYLISTS: 'PLAYLISTS',
  Songs: 'Morceaux', Artists: 'Artistes', Albums: 'Albums', Podcasts: 'Podcasts',
  Audiobooks: 'Livres audio', Apps: 'Apps', Radio: 'Radio', Missing: 'Manquants',
  Review: 'À compléter', Admin: 'Serveur', Sources: 'Sources', Sharing: 'Partage',
  Duplicates: 'Doublons', 'All Playlists': 'Toutes les playlists',
  // Columns
  Name: 'Titre', Time: 'Durée', Artist: 'Artiste', Album: 'Album', Genre: 'Genre',
  Rating: 'Note', Plays: 'Lectures', Year: 'Année', Kind: 'Type', Format: 'Format',
  Size: 'Taille', 'Date Added': 'Date d’ajout', 'Last Played': 'Dernière lecture',
  Skips: 'Sauts', 'On device': 'Sur l’appareil', Tags: 'Tags', Status: 'État',
  // Menu and actions
  Play: 'Lire', 'Play Next': 'Lire ensuite', 'Add to Queue': 'Ajouter à la file',
  'Get Info': 'Informations', 'Go to Album': 'Voir l’album',
  'Where is this track…': 'Où est ce morceau…', 'Convert…': 'Convertir…',
  'Add to Playlist': 'Ajouter à une playlist', 'Add to Device': 'Ajouter à un appareil',
  'New Playlist…': 'Nouvelle playlist…', Tag: 'Tag', 'New tag…': 'Nouveau tag…',
  'Check Selection': 'Cocher la sélection', 'Uncheck Selection': 'Décocher la sélection',
  'Reset Plays': 'Remettre les lectures à zéro', 'Delete from Library': 'Supprimer de la bibliothèque',
  'Remove from Playlist': 'Retirer de la playlist', None: 'Aucune',
  Cancel: 'Annuler', OK: 'OK', Remove: 'Retirer', 'Really remove?': 'Vraiment retirer ?',
  Refresh: 'Actualiser', Scan: 'Scanner', Test: 'Tester', Back: 'Retour',
  // Player and status
  Previous: 'Précédent', 'Play/Pause': 'Lire/Pause', Next: 'Suivant', Shuffle: 'Aléatoire',
  Search: 'Rechercher', 'Column Browser': 'Navigateur par colonnes', 'The queue': 'La file',
  'No songs': 'Aucun morceau', 'Loading…': 'Chargement…', 'Nothing here.': 'Rien ici.',
  songs: 'morceaux', song: 'morceau',
}

const it: Dict = {
  Scanning: 'Scansione', Converting: 'Conversione', Fingerprinting: 'Impronte',
  'Refreshing podcasts': 'Aggiornamento podcast', 'Writing tags': 'Scrittura dei tag',
  Syncing: 'Sincronizzazione', Downloading: 'Download', Analysing: 'Analisi',
  Relaying: 'Inoltro', 'Moving files': 'Spostamento dei file',
  '{done} of {total}': '{done} di {total}', '{done} so far': '{done} finora',

  'Any {what}': 'Qualsiasi {what}', 'Clear {n} filters': 'Azzera {n} filtri',
  'Nothing to filter by': 'Niente da filtrare', 'All ({n} {what})': 'Tutti ({n} {what})',
  Genres: 'Generi', Quality: 'Qualità', Device: 'Dispositivo',

  '{n} songs, {duration}, {size}': '{n} brani, {duration}, {size}', '{n} days': '{n} giorni',
  'New playlist': 'Nuova playlist', Repeat: 'Ripeti',

  '{n} in the queue': '{n} in coda',

  'Add {n} to Queue': 'Aggiungi {n} alla coda', 'Convert {n} Tracks…': 'Converti {n} brani…',
  Language: 'Lingua',

  Home: 'Home', LIBRARY: 'LIBRERIA', DEVICES: 'DISPOSITIVI', SERVER: 'SERVER',
  STORE: 'STORE', PLAYLISTS: 'PLAYLIST',
  Songs: 'Brani', Artists: 'Artisti', Albums: 'Album', Podcasts: 'Podcast',
  Audiobooks: 'Audiolibri', Apps: 'App', Radio: 'Radio', Missing: 'Mancanti',
  Review: 'Da completare', Admin: 'Server', Sources: 'Sorgenti', Sharing: 'Condivisione',
  Duplicates: 'Duplicati', 'All Playlists': 'Tutte le playlist',
  Name: 'Titolo', Time: 'Durata', Artist: 'Artista', Album: 'Album', Genre: 'Genere',
  Rating: 'Voto', Plays: 'Riproduzioni', Year: 'Anno', Kind: 'Tipo', Format: 'Formato',
  Size: 'Dimensione', 'Date Added': 'Aggiunto il', 'Last Played': 'Ultima riproduzione',
  Skips: 'Salti', 'On device': 'Sul dispositivo', Tags: 'Tag', Status: 'Stato',
  Play: 'Riproduci', 'Play Next': 'Riproduci dopo', 'Add to Queue': 'Aggiungi alla coda',
  'Get Info': 'Informazioni', 'Go to Album': 'Vai all’album',
  'Where is this track…': 'Dov’è questo brano…', 'Convert…': 'Converti…',
  'Add to Playlist': 'Aggiungi a playlist', 'Add to Device': 'Aggiungi al dispositivo',
  'New Playlist…': 'Nuova playlist…', Tag: 'Tag', 'New tag…': 'Nuovo tag…',
  'Check Selection': 'Seleziona i segni', 'Uncheck Selection': 'Togli i segni',
  'Reset Plays': 'Azzera le riproduzioni', 'Delete from Library': 'Elimina dalla libreria',
  'Remove from Playlist': 'Rimuovi dalla playlist', None: 'Nessuno',
  Cancel: 'Annulla', OK: 'OK', Remove: 'Rimuovi', 'Really remove?': 'Rimuovere davvero?',
  Refresh: 'Aggiorna', Scan: 'Scansiona', Test: 'Prova', Back: 'Indietro',
  Previous: 'Precedente', 'Play/Pause': 'Riproduci/Pausa', Next: 'Successivo', Shuffle: 'Casuale',
  Search: 'Cerca', 'Column Browser': 'Browser a colonne', 'The queue': 'La coda',
  'No songs': 'Nessun brano', 'Loading…': 'Caricamento…', 'Nothing here.': 'Niente qui.',
  songs: 'brani', song: 'brano',
}

const es: Dict = {
  Scanning: 'Escaneando', Converting: 'Convirtiendo', Fingerprinting: 'Huellas',
  'Refreshing podcasts': 'Actualizando pódcasts', 'Writing tags': 'Escribiendo etiquetas',
  Syncing: 'Sincronizando', Downloading: 'Descargando', Analysing: 'Analizando',
  Relaying: 'Retransmitiendo', 'Moving files': 'Moviendo archivos',
  '{done} of {total}': '{done} de {total}', '{done} so far': '{done} hasta ahora',

  'Any {what}': 'Cualquier {what}', 'Clear {n} filters': 'Borrar {n} filtros',
  'Nothing to filter by': 'Nada que filtrar', 'All ({n} {what})': 'Todo ({n} {what})',
  Genres: 'Géneros', Quality: 'Calidad', Device: 'Dispositivo',

  '{n} songs, {duration}, {size}': '{n} canciones, {duration}, {size}', '{n} days': '{n} días',
  'New playlist': 'Nueva lista', Repeat: 'Repetir',

  '{n} in the queue': '{n} en la cola',

  'Add {n} to Queue': 'Añadir {n} a la cola', 'Convert {n} Tracks…': 'Convertir {n} pistas…',
  Language: 'Idioma',

  Home: 'Inicio', LIBRARY: 'BIBLIOTECA', DEVICES: 'DISPOSITIVOS', SERVER: 'SERVIDOR',
  STORE: 'TIENDA', PLAYLISTS: 'LISTAS',
  Songs: 'Canciones', Artists: 'Artistas', Albums: 'Álbumes', Podcasts: 'Pódcasts',
  Audiobooks: 'Audiolibros', Apps: 'Apps', Radio: 'Radio', Missing: 'Ausentes',
  Review: 'Por completar', Admin: 'Servidor', Sources: 'Fuentes', Sharing: 'Compartir',
  Duplicates: 'Duplicados', 'All Playlists': 'Todas las listas',
  Name: 'Título', Time: 'Duración', Artist: 'Artista', Album: 'Álbum', Genre: 'Género',
  Rating: 'Valoración', Plays: 'Reproducciones', Year: 'Año', Kind: 'Tipo', Format: 'Formato',
  Size: 'Tamaño', 'Date Added': 'Fecha de adición', 'Last Played': 'Última reproducción',
  Skips: 'Saltos', 'On device': 'En el dispositivo', Tags: 'Etiquetas', Status: 'Estado',
  Play: 'Reproducir', 'Play Next': 'Reproducir a continuación', 'Add to Queue': 'Añadir a la cola',
  'Get Info': 'Información', 'Go to Album': 'Ir al álbum',
  'Where is this track…': '¿Dónde está esta pista…', 'Convert…': 'Convertir…',
  'Add to Playlist': 'Añadir a una lista', 'Add to Device': 'Añadir al dispositivo',
  'New Playlist…': 'Nueva lista…', Tag: 'Etiqueta', 'New tag…': 'Nueva etiqueta…',
  'Check Selection': 'Marcar la selección', 'Uncheck Selection': 'Desmarcar la selección',
  'Reset Plays': 'Reiniciar reproducciones', 'Delete from Library': 'Eliminar de la biblioteca',
  'Remove from Playlist': 'Quitar de la lista', None: 'Ninguna',
  Cancel: 'Cancelar', OK: 'OK', Remove: 'Quitar', 'Really remove?': '¿Quitar de verdad?',
  Refresh: 'Actualizar', Scan: 'Escanear', Test: 'Probar', Back: 'Atrás',
  Previous: 'Anterior', 'Play/Pause': 'Reproducir/Pausa', Next: 'Siguiente', Shuffle: 'Aleatorio',
  Search: 'Buscar', 'Column Browser': 'Explorador por columnas', 'The queue': 'La cola',
  'No songs': 'Sin canciones', 'Loading…': 'Cargando…', 'Nothing here.': 'Nada aquí.',
  songs: 'canciones', song: 'canción',
}

const de: Dict = {
  Scanning: 'Scannen', Converting: 'Konvertieren', Fingerprinting: 'Fingerprints',
  'Refreshing podcasts': 'Podcasts aktualisieren', 'Writing tags': 'Tags schreiben',
  Syncing: 'Synchronisieren', Downloading: 'Herunterladen', Analysing: 'Analysieren',
  Relaying: 'Weiterleiten', 'Moving files': 'Dateien verschieben',
  '{done} of {total}': '{done} von {total}', '{done} so far': '{done} bisher',

  'Any {what}': 'Alle {what}', 'Clear {n} filters': '{n} Filter zurücksetzen',
  'Nothing to filter by': 'Nichts zum Filtern', 'All ({n} {what})': 'Alle ({n} {what})',
  Genres: 'Genres', Quality: 'Qualität', Device: 'Gerät',

  '{n} songs, {duration}, {size}': '{n} Titel, {duration}, {size}', '{n} days': '{n} Tage',
  'New playlist': 'Neue Playlist', Repeat: 'Wiederholen',

  '{n} in the queue': '{n} in der Warteschlange',

  'Add {n} to Queue': '{n} zur Warteschlange', 'Convert {n} Tracks…': '{n} Titel konvertieren…',
  Language: 'Sprache',

  Home: 'Start', LIBRARY: 'MEDIATHEK', DEVICES: 'GERÄTE', SERVER: 'SERVER',
  STORE: 'STORE', PLAYLISTS: 'PLAYLISTS',
  Songs: 'Titel', Artists: 'Interpreten', Albums: 'Alben', Podcasts: 'Podcasts',
  Audiobooks: 'Hörbücher', Apps: 'Apps', Radio: 'Radio', Missing: 'Fehlend',
  Review: 'Unvollständig', Admin: 'Server', Sources: 'Quellen', Sharing: 'Freigabe',
  Duplicates: 'Duplikate', 'All Playlists': 'Alle Playlists',
  Name: 'Titel', Time: 'Dauer', Artist: 'Interpret', Album: 'Album', Genre: 'Genre',
  Rating: 'Bewertung', Plays: 'Wiedergaben', Year: 'Jahr', Kind: 'Art', Format: 'Format',
  Size: 'Größe', 'Date Added': 'Hinzugefügt am', 'Last Played': 'Zuletzt gespielt',
  Skips: 'Übersprungen', 'On device': 'Auf dem Gerät', Tags: 'Tags', Status: 'Status',
  Play: 'Abspielen', 'Play Next': 'Als Nächstes', 'Add to Queue': 'Zur Warteschlange',
  'Get Info': 'Informationen', 'Go to Album': 'Zum Album',
  'Where is this track…': 'Wo ist dieser Titel…', 'Convert…': 'Konvertieren…',
  'Add to Playlist': 'Zu Playlist hinzufügen', 'Add to Device': 'Zu Gerät hinzufügen',
  'New Playlist…': 'Neue Playlist…', Tag: 'Tag', 'New tag…': 'Neuer Tag…',
  'Check Selection': 'Auswahl anhaken', 'Uncheck Selection': 'Haken entfernen',
  'Reset Plays': 'Wiedergaben zurücksetzen', 'Delete from Library': 'Aus Mediathek löschen',
  'Remove from Playlist': 'Aus Playlist entfernen', None: 'Keine',
  Cancel: 'Abbrechen', OK: 'OK', Remove: 'Entfernen', 'Really remove?': 'Wirklich entfernen?',
  Refresh: 'Aktualisieren', Scan: 'Scannen', Test: 'Testen', Back: 'Zurück',
  Previous: 'Zurück', 'Play/Pause': 'Abspielen/Pause', Next: 'Weiter', Shuffle: 'Zufall',
  Search: 'Suchen', 'Column Browser': 'Spaltenbrowser', 'The queue': 'Die Warteschlange',
  'No songs': 'Keine Titel', 'Loading…': 'Wird geladen…', 'Nothing here.': 'Nichts hier.',
  songs: 'Titel', song: 'Titel',
}

const DICTS: Record<Locale, Dict> = { en: {}, fr, it, es, de }

/**
 * The chosen language, or the browser's if it is one we have.
 *
 * Stored per browser rather than per account: it is a property of the person
 * reading, and the same account read from a French laptop and an English phone
 * wants two different answers.
 */
const KEY = 'jukebox.locale'

function initial(): Locale {
  const saved = localStorage.getItem(KEY) as Locale | null
  if (saved && saved in LOCALES) return saved
  const tag = (navigator.language || 'en').slice(0, 2) as Locale
  return tag in LOCALES ? tag : 'en'
}

let current: Locale = typeof localStorage === 'undefined' ? 'en' : initial()
const listeners = new Set<() => void>()

// `lang` on the document, not only on a change: it is what a screen reader
// picks a voice from and what the browser hyphenates by, and the first load is
// the one that would otherwise claim English for a French interface.
if (typeof document !== 'undefined') document.documentElement.lang = current

export function setLocale(next: Locale) {
  if (next === current) return
  current = next
  localStorage.setItem(KEY, next)
  document.documentElement.lang = next
  for (const cb of listeners) cb()
}

export const getLocale = () => current

/**
 * Translate, falling back to the key — which is the English.
 *
 * `{name}` placeholders are filled from `vars`. Interpolation rather than
 * string concatenation, because word order is the first thing a translation
 * changes: "3 songs added" and "3 Titel hinzugefügt" put the number in the same
 * place, but plenty of sentences do not.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = DICTS[current][key] ?? key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

/** Re-renders whoever reads it when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => current,
  )
}

/**
 * Numbers and dates in the reader's language.
 *
 * Every `toLocaleString('en-US')` in this app was a decision nobody made: it
 * prints 1,234 to a French reader who writes 1 234. These take the chosen
 * locale, so the separator, the month name and the order of a date all follow
 * the same switch as the words.
 */
export const num = (n: number) => n.toLocaleString(current)
export const date = (ms: number, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(ms).toLocaleDateString(current, opts)
export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString(current, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

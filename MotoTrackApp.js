import { writeBatch, doc, updateDoc, deleteDoc, serverTimestamp, 
collection, getDoc, getDocs, query as fsQuery, where, setDoc, onSnapshot} from "firebase/firestore";
import { signInWithEmailAndPassword, signOut, updatePassword, EmailAuthProvider, reauthenticateWithCredential, onAuthStateChanged } from "firebase/auth";
import { db, auth } from "./firebase";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, StatusBar, SafeAreaView, Platform, Alert, Modal,
  useWindowDimensions, KeyboardAvoidingView,
} from "react-native";

// ─── File picker cross-platform ───────────────────────────────────────────
let DocumentPicker = null;
if (Platform.OS !== "web") {
  try { DocumentPicker = require("expo-document-picker"); } catch (_) {}
}

// ─── RBAC ──────────────────────────────────────────────────────────────────
const ROLES = { admin: "admin", supervisor: "supervisor", agent: "agent" };
const PERMISSIONS = {
  admin:      new Set(["search","upload","stats","params","admin_panel","delete_account","toggle_account","change_role","change_own_password"]),
  supervisor: new Set(["search","upload","stats","params","toggle_account","change_own_password"]),
  agent:      new Set(["search","stats","params","change_own_password"]),
};

function can(user, permission) {
  if (!user?.role) return false;
  return PERMISSIONS[user.role]?.has(permission) ?? false;
}

// ─── localStorage helpers ─────────────────────────────────────────────────
function lsGet(key) {
  try { if (Platform.OS === "web" && typeof localStorage !== "undefined") return localStorage.getItem(key); } catch (_) {}
  return null;
}
function lsSet(key, value) {
  try { if (Platform.OS === "web" && typeof localStorage !== "undefined") localStorage.setItem(key, String(value)); } catch (_) {}
}

// ─── Sync cross-session ────────────────────────────────────────────────────
const SYNC_KEY_TS   = "mt_db_ts";
const SYNC_KEY_AL   = "mt_al_delay";
const SYNC_INTERVAL = 30_000;

function getSyncTs() { return parseInt(lsGet(SYNC_KEY_TS) || "0", 10); }
function setSyncTs(ts) { lsSet(SYNC_KEY_TS, ts); }

function useSyncWatcher(lastSync, onOutOfSync) {
  const ownTs = useRef(lastSync);
  useEffect(() => { ownTs.current = lastSync; }, [lastSync]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const id = setInterval(() => {
      const stored = getSyncTs();
      if (stored > (ownTs.current || 0)) onOutOfSync(stored);
    }, SYNC_INTERVAL);
    return () => clearInterval(id);
  }, [onOutOfSync]);
}

// ─── Auto-logout ──────────────────────────────────────────────────────────
const AUTO_LOGOUT_WARNING_MS  = 60_000;
const AUTO_LOGOUT_OPTIONS_MIN = [5, 10, 15, 30, 60];
const DEFAULT_AL_MIN          = 15;

function alMinToMs(min) { return min * 60 * 1000; }
function alMsToMin(ms)  { return Math.round(ms / 60_000); }

function useAutoLogout(active, delayMs, onLogout, showToast, warningText) {
  const timerLogout  = useRef(null);
  const timerWarning = useRef(null);
  const onLogoutRef  = useRef(onLogout);
  const showToastRef = useRef(showToast);
  const warningRef   = useRef(warningText);

  useEffect(() => { onLogoutRef.current  = onLogout;    }, [onLogout]);
  useEffect(() => { showToastRef.current = showToast;   }, [showToast]);
  useEffect(() => { warningRef.current   = warningText; }, [warningText]);

  const reset = useCallback(() => {
    clearTimeout(timerLogout.current);
    clearTimeout(timerWarning.current);
    if (!active || delayMs <= 0) return;
    const warnAt = delayMs - AUTO_LOGOUT_WARNING_MS;
    if (warnAt > 0) {
      timerWarning.current = setTimeout(() => showToastRef.current("err", warningRef.current), warnAt);
    }
    timerLogout.current = setTimeout(() => onLogoutRef.current(), delayMs);
  }, [active, delayMs]);

  useEffect(() => {
    reset();
    return () => { clearTimeout(timerLogout.current); clearTimeout(timerWarning.current); };
  }, [reset]);

  return reset;
}

// ─── Hook responsive ──────────────────────────────────────────────────────
function useResponsive() {
  const { width, height } = useWindowDimensions();
  const isMobile  = width < 640;
  const isTablet  = width >= 640 && width < 1024;
  const isDesktop = width >= 1024;
  const isWide    = !isMobile;
  // Pleine largeur pour la page principale (pas de colonne étroite)
  const appWidth        = width;
  // Pas de restriction sur le contenu de la page principale
  const contentMaxWidth = undefined;
  // Largeur max des modales uniquement
  const modalMaxWidth   = isDesktop ? 680 : isTablet ? 560 : undefined;
  return { width, height, isMobile, isTablet, isDesktop, isWide, appWidth, contentMaxWidth, modalMaxWidth };
}

// ─── i18n ─────────────────────────────────────────────────────────────────
const TRANSLATIONS = {
  fr: {
    tagline:                  "Gestion de flotte moto",
    login_id:                 "Identifiant",
    login_id_ph:              "Votre identifiant",
    login_pw:                 "Mot de passe",
    login_btn:                "Se connecter →",
    copyright:                 "© {year} MotoTrack — Développé par RGC Quantium. Tous droits réservés.",
    logout:                   "⏏ Déconnexion",
    error:                    "Erreur",
    fields_required:          "Identifiant et mot de passe requis",
    invalid_creds:            "Identifiants invalides ou compte non activé",
    access_denied:            "Accès refusé",
    access_denied_msg:        "Vous n'avez pas les droits nécessaires.",
    nav_search:               "Recherche",
    nav_upload:               "Base",
    nav_stats:                "Stats",
    nav_params:               "Params",
    nav_admin:                "Admin",
    tab_moto:                 "🏍️ N° Moto",
    tab_plate:                "🔖 N° Plaque",
    tab_chassis:              "🔩 N° Châssis",
    ph_moto:                  "Ex : CM2211",
    ph_plate:                 "Ex : LT 4521 A",
    ph_chassis:               "Ex : VIN123456789",
    found_via_moto:           "N° moto",
    found_via_plate:          "N° plaque",
    found_via_chassis:        "N° châssis",
    moto_label:               "N° Moto",
    section_client:           "Informations client",
    section_moto:             "Informations moto",
    row_name:                 "👤 Nom",
    row_phone:                "📞 Téléphone",
    row_date:                 "📅 Date d'achat",
    row_plate:                "🔖 N° de plaque",
    row_chassis:              "🔩 N° de châssis",
    row_moto_type:            "🏍️ Type de moto",
    row_status:               "📋 Statut",
    status_end:               "Fin de contrat",
    status_under:             "Sous contrat",
    status_upfront:           "Prépayé",
    status_internal:          "Usage interne",
    empty_noresult:           "Aucun résultat pour",
    empty_prompt:             "Recherchez par",
    empty_prompt2:            "pour afficher les informations client",
    empty_default_moto:       "numéro de moto",
    empty_default_plate:      "numéro de plaque",
    empty_default_chassis:    "numéro de châssis",
    upload_title:             "Base de données",
    upload_count:             "moto(s) en mémoire",
    upload_close:             "✕ Fermer",
    upload_drop:              "Sélectionner un fichier",
    upload_click:             "Appuyez pour choisir un .csv",
    upload_formats:           "Format : .csv",
    upload_missing_cols:      "Colonnes manquantes : ",
    upload_csv_guide:         "Format CSV attendu",
    upload_status_values:     "Valeurs de statut valides",
    upload_reset:             "↩ Remettre les données de démonstration",
    upload_reset_ok:          "✅ Données de démo rechargées.",
    upload_ok:                "✅ Base importée avec succès",
    upload_err_web:           "Erreur lors de l'import",
    upload_err_parse:         "Fichier invalide ou mal formaté",
    upload_empty:             "Aucune donnée valide trouvée dans le fichier",
    export_btn:               "⬇ Exporter la base en CSV",
    export_filename:          "mototrack_export.csv",
    export_native_msg:        "L'export fichier nécessite expo-file-system en build natif.",
    stats_header_title:       "Statistiques",
    stats_header_sub:         "Données en temps réel de votre flotte",
    stats_total:              "Total motos",
    stats_by_status:          "RÉPARTITION PAR STATUT",
    stats_by_moto:            "MOTOS LES PLUS FRÉQUENTES",
    stats_last_import:        "Dernière mise à jour",
    stats_section_info:       "INFORMATIONS",
    stats_avail_label:        "Source",
    stats_avail_value:        "Base en mémoire",
    adm_title:                "Administration",
    adm_sub:                  "Gestion des accès et comptes",
    adm_section_agents:       "COMPTES UTILISATEURS",
    adm_no_agents:            "Aucun utilisateur enregistré",
    adm_status_active:        "Actif",
    adm_status_inactive:      "Inactif",
    adm_deactivate:           "Désactiver",
    adm_activate:             "Activer",
    adm_delete:               "Supprimer",
    adm_delete_confirm:       "Supprimer ce compte ?",
    adm_delete_confirm_msg:   "Cette action est irréversible.",
    adm_role_agent:           "Agent",
    adm_role_supervisor:      "Superviseur",
    adm_role_admin:           "Admin",
    params_header_title:      "Paramètres",
    params_header_sub:        "Configuration de l'application",
    params_lang_section:      "LANGUE",
    params_lang_label:        "Langue de l'interface",
    params_lang_action:       "Changer →",
    params_lang_picker_title: "Choisir la langue",
    params_lang_picker_sub:   "Sélectionnez la langue de l'interface",
    params_lang_fr:           "Français",
    params_lang_en:           "English",
    params_lang_back:         "← Retour aux paramètres",
    params_security_section:  "SÉCURITÉ",
    params_chpw_label:        "Changer le mot de passe",
    params_chpw_action:       "Modifier →",
    params_chpw_title:        "Changement de mot de passe",
    params_chpw_current:      "Mot de passe actuel",
    params_chpw_new:          "Nouveau mot de passe (min. 6 car.)",
    params_chpw_confirm:      "Confirmer le nouveau mot de passe",
    params_chpw_btn:          "Enregistrer →",
    params_chpw_ok:           "✅ Mot de passe modifié avec succès",
    params_chpw_wrong_current:"Mot de passe actuel incorrect.",
    params_chpw_mismatch:     "Les mots de passe ne correspondent pas.",
    params_auto_logout_label: "Déconnexion automatique",
    params_auto_logout_action:"Configurer →",
    params_al_title:          "Durée d'inactivité",
    params_al_sub:            "Choisissez le délai avant déconnexion automatique.",
    params_al_unit:           "min",
    params_al_save:           "✓ Enregistrer",
    params_al_saved:          "✅ Délai enregistré.",
    params_al_current:        "Actuel :",
    params_al_quick_select:   "SÉLECTION RAPIDE",
    params_al_custom:         "DURÉE PERSONNALISÉE (1–480 min)",
    params_al_custom_ph:      "ex : 45",
    params_al_selected:       "Durée sélectionnée",
    params_al_inactivity:     "d'inactivité",
    params_al_invalid:        "Durée invalide (1–480 min)",
    params_pin_label:         "Code PIN",
    params_pin_value:         "Bientôt disponible",
    params_app_section:       "APPLICATION",
    params_version_label:     "Version",
    params_version_value:     "1.0.0",
    params_support_label:     "Support",
    params_support_value:     "contact@mototrack.app",
    params_soon:              "Bientôt",
    btn_back:                 "← Retour",
    sync_never:               "jamais",
    sync_stale:               "⚠️ Base ancienne",
    sync_update_available:    "🔄 Mise à jour disponible",
    auto_logout_warning:      "⚠️ Déconnexion dans 1 minute pour inactivité.",
    auto_logout_done:         "Session expirée. Veuillez vous reconnecter.",
    role_admin:               "ADMIN",
    role_supervisor:          "SUPERVISEUR",
    role_agent:               "AGENT",
    import_success:           "Base importée dans Firestore",
    import_error:             "Échec de l'import CSV",
    success:                  "Succès",
    err_cannot_delete_admin:  "Impossible de supprimer un administrateur",
    err_cannot_delete_self:   "Vous ne pouvez pas supprimer votre compte",
    err_delete:               "Suppression impossible",
    err_role:                 "Impossible de changer le rôle",
    err_toggle:               "Impossible de modifier le compte",
    about_title:        "À propos",
    about_sub:          "Informations sur l'application",
    about_desc:         "MotoTrack est une application de gestion de flotte de motos. Elle permet de consulter rapidement les informations des véhicules via leur numéro de moto, plaque ou châssis.",
    about_dev:          "Développeur",
    about_client:       "Client",
    about_company:      "RGC Quantium",
    about_client_name:  "SPIRO",
    about_version:      "Version",
    about_contact:      "Contact",
  },
  en: {
    tagline:                  "Motorcycle fleet management",
    login_id:                 "Username",
    login_id_ph:              "Your username",
    login_pw:                 "Password",
    login_btn:                "Log in →",
    copyright:                "© {year} MotoTrack — Developed by RGC Quantium. All rights reserved.",
    logout:                   "⏏ Logout",
    error:                    "Error",
    fields_required:          "Username and password are required",
    invalid_creds:            "Invalid credentials or account not activated",
    access_denied:            "Access denied",
    access_denied_msg:        "You do not have the required permissions.",
    nav_search:               "Search",
    nav_upload:               "Data",
    nav_stats:                "Stats",
    nav_params:               "Settings",
    nav_admin:                "Admin",
    tab_moto:                 "🏍️ Moto N°",
    tab_plate:                "🔖 Plate N°",
    tab_chassis:              "🔩 Chassis N°",
    ph_moto:                  "E.g.: CM2211",
    ph_plate:                 "E.g.: LT 4521 A",
    ph_chassis:               "E.g.: VIN123456789",
    found_via_moto:           "Moto N°",
    found_via_plate:          "Plate N°",
    found_via_chassis:        "Chassis N°",
    moto_label:               "Moto N°",
    section_client:           "Client information",
    section_moto:             "Motorcycle information",
    row_name:                 "👤 Name",
    row_phone:                "📞 Phone",
    row_date:                 "📅 Purchase date",
    row_plate:                "🔖 Plate N°",
    row_chassis:              "🔩 Chassis N°",
    row_moto_type:            "🏍️ Moto type",
    row_status:               "📋 Status",
    status_end:               "End of Contract",
    status_under:             "Under Contract",
    status_upfront:           "Upfront",
    status_internal:          "Internal Use",
    empty_noresult:           "No result for",
    empty_prompt:             "Search by",
    empty_prompt2:            "to display client information",
    empty_default_moto:       "moto number",
    empty_default_plate:      "plate number",
    empty_default_chassis:    "chassis number",
    upload_title:             "Database",
    upload_count:             "moto(s) in memory",
    upload_close:             "✕ Close",
    upload_drop:              "Select a file",
    upload_click:             "Tap to choose a .csv file",
    upload_formats:           "Format: .csv",
    upload_missing_cols:      "Missing columns: ",
    upload_csv_guide:         "Expected CSV format",
    upload_status_values:     "Valid status values",
    upload_reset:             "↩ Restore demo data",
    upload_reset_ok:          "✅ Demo data restored.",
    upload_ok:                "✅ Database imported successfully",
    upload_err_web:           "Import error",
    upload_err_parse:         "Invalid or malformed file",
    upload_empty:             "No valid data found in file",
    export_btn:               "⬇ Export database as CSV",
    export_filename:          "mototrack_export.csv",
    export_native_msg:        "File export requires expo-file-system in native build.",
    stats_header_title:       "Statistics",
    stats_header_sub:         "Real-time fleet data",
    stats_total:              "Total motos",
    stats_by_status:          "BREAKDOWN BY STATUS",
    stats_by_moto:            "TOP MOTO TYPES",
    stats_last_import:        "Last updated",
    stats_section_info:       "INFORMATION",
    stats_avail_label:        "Source",
    stats_avail_value:        "In-memory database",
    adm_title:                "Administration",
    adm_sub:                  "Access and account management",
    adm_section_agents:       "USER ACCOUNTS",
    adm_no_agents:            "No users registered",
    adm_status_active:        "Active",
    adm_status_inactive:      "Inactive",
    adm_deactivate:           "Deactivate",
    adm_activate:             "Activate",
    adm_delete:               "Delete",
    adm_delete_confirm:       "Delete this account?",
    adm_delete_confirm_msg:   "This action is irreversible.",
    adm_role_agent:           "Agent",
    adm_role_supervisor:      "Supervisor",
    adm_role_admin:           "Admin",
    params_header_title:      "Settings",
    params_header_sub:        "Application configuration",
    params_lang_section:      "LANGUAGE",
    params_lang_label:        "Interface language",
    params_lang_action:       "Change →",
    params_lang_picker_title: "Choose language",
    params_lang_picker_sub:   "Select the interface language",
    params_lang_fr:           "Français",
    params_lang_en:           "English",
    params_lang_back:         "← Back to settings",
    params_security_section:  "SECURITY",
    params_chpw_label:        "Change password",
    params_chpw_action:       "Update →",
    params_chpw_title:        "Change password",
    params_chpw_current:      "Current password",
    params_chpw_new:          "New password (min. 6 chars)",
    params_chpw_confirm:      "Confirm new password",
    params_chpw_btn:          "Save →",
    params_chpw_ok:           "✅ Password changed successfully",
    params_chpw_wrong_current:"Current password is incorrect.",
    params_chpw_mismatch:     "Passwords do not match.",
    params_auto_logout_label: "Automatic logout",
    params_auto_logout_action:"Configure →",
    params_al_title:          "Inactivity duration",
    params_al_sub:            "Choose the delay before automatic logout.",
    params_al_unit:           "min",
    params_al_save:           "✓ Save",
    params_al_saved:          "✅ Delay saved.",
    params_al_current:        "Current:",
    params_al_quick_select:   "QUICK SELECT",
    params_al_custom:         "CUSTOM DURATION (1–480 min)",
    params_al_custom_ph:      "e.g.: 45",
    params_al_selected:       "Selected duration",
    params_al_inactivity:     "of inactivity",
    params_al_invalid:        "Invalid duration (1–480 min)",
    params_pin_label:         "PIN code",
    params_pin_value:         "Coming soon",
    params_app_section:       "APPLICATION",
    params_version_label:     "Version",
    params_version_value:     "1.0.0",
    params_support_label:     "Support",
    params_support_value:     "contact@mototrack.app",
    params_soon:              "Soon",
    btn_back:                 "← Back",
    sync_never:               "never",
    sync_stale:               "⚠️ Stale database",
    sync_update_available:    "🔄 Update available",
    auto_logout_warning:      "⚠️ You will be logged out in 1 minute due to inactivity.",
    auto_logout_done:         "Session expired. Please log in again.",
    role_admin:               "ADMIN",
    role_supervisor:          "SUPERVISOR",
    role_agent:               "AGENT",
    import_success:           "Database imported into Firestore",
    import_error:             "CSV import failed",
    success:                  "Success",
    err_cannot_delete_admin:  "Cannot delete an administrator",
    err_cannot_delete_self:   "You cannot delete your own account",
    err_delete:               "Deletion failed",
    err_role:                 "Cannot change role",
    err_toggle:               "Cannot update account",
    about_title:        "About",
    about_sub:          "Application information",
    about_desc:         "MotoTrack is a motorcycle fleet management application. It allows quick access to vehicle information using moto number, plate number or chassis number.",
    about_dev:          "Developer",
    about_client:       "Client",
    about_company:      "RGC Quantium",
    about_client_name:  "SPIRO",
    about_version:      "Version",
    about_contact:      "Contact",
  },
};
const getT = (lang) => TRANSLATIONS[lang] || TRANSLATIONS.fr;

// ─── Données de démo ──────────────────────────────────────────────────────
const DEFAULT_DATA = {
  CM2211: { name: "Jean-Pierre Mbarga", phone: "+229 6 91 23 45 67", date: "12 Mars 2023",  plate: "LT 4521 A",  chassis: "VIN1MT001CM2211AA", moto: "COMMANDO",   status: "under"    },
  DK4478: { name: "Fatou Diallo",       phone: "+229 6 75 88 12 34", date: "05 Juin 2022",  plate: "DL 8833 B",  chassis: "VIN1MT002DK4478BB", moto: "CHAP CHAP",  status: "end"      },
  YA9901: { name: "Cyrille Nkomo",      phone: "+229 6 52 00 77 89", date: "20 Jan. 2024",  plate: "YA 1109 C",  chassis: "VIN1MT003YA9901CC", moto: "EKON",       status: "upfront"  },
  INT005: { name: "Service Logistique", phone: "+229 2 22 30 00 01", date: "01 Sep. 2021",  plate: "INT 005 Z",  chassis: "VIN1MT004INT005DD", moto: "M ELECTRIC", status: "internal" },
};

// ─── Design tokens ────────────────────────────────────────────────────────
const T = {
  bg:       "#0a0c10",
  surface:  "#12151c",
  surface2: "#1a1e28",
  border:   "#252a38",
  accent:   "#f97316",
  text:     "#e8eaf0",
  muted:    "#6b7280",
  green:    "#22c55e",
  blue:     "#3b82f6",
  yellow:   "#eab308",
  red:      "#ef4444",
  purple:   "#a855f7",
};

const ROLE_COLOR = { admin: T.green, supervisor: T.purple, agent: T.blue };
const STATUS_COLOR = {
  end:      { color: T.red,    bg: "rgba(239,68,68,0.15)",  border: "rgba(239,68,68,0.3)"  },
  under:    { color: T.green,  bg: "rgba(34,197,94,0.15)",  border: "rgba(34,197,94,0.3)"  },
  upfront:  { color: T.blue,   bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.3)" },
  internal: { color: T.yellow, bg: "rgba(234,179,8,0.15)",  border: "rgba(234,179,8,0.3)"  },
};
const VALID_STATUSES = Object.keys(STATUS_COLOR);

const getStatusLabel = (status, t) => {
  const map = { end: t.status_end, under: t.status_under, upfront: t.status_upfront, internal: t.status_internal };
  return map[status] || t.status_internal;
};

function sanitize(str) {
  return String(str || "").replace(/[<>"'`]/g, "").trim().slice(0, 200);
}

// ─── CSV ──────────────────────────────────────────────────────────────────
function splitCSVLine(line) {
  const result = []; let cur = ""; let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === "," && !inQuote) { result.push(cur); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseCSV(text, t) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { error: t.upload_empty };
  const headers = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/"/g, ""));
  const required = ["id","name","phone","date","plate","chassis","moto","status"];
  const missing  = required.filter((r) => !headers.includes(r));
  if (missing.length) return { error: `${t.upload_missing_cols}${missing.join(", ")}` };
  const data = {}; let validCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]); const row = {};
    headers.forEach((h, idx) => { row[h] = sanitize(cols[idx] || ""); });
    const id = row.id.toUpperCase(); const status = row.status.toLowerCase();
    if (!id || id.length < 2 || !VALID_STATUSES.includes(status) || !row.name || !row.phone || !row.plate) continue;
    data[id] = { name: row.name, phone: row.phone, date: row.date||"—", plate: row.plate, chassis: row.chassis||"—", moto: row.moto||"—", status };
    validCount++;
  }
  if (validCount === 0) return { error: t.upload_empty };
  return { data, count: validCount };
}

function exportCSV(data, t) {
  const header = "id,name,phone,date,plate,chassis,moto,status";
  const rows   = Object.entries(data).map(([id, d]) =>
    [id,d.name,d.phone,d.date,d.plate,d.chassis||"",d.moto,d.status]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = [header, ...rows].join("\n");
  if (Platform.OS === "web") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = t.export_filename; a.click();
    URL.revokeObjectURL(url);
  } else { Alert.alert("Export", t.export_native_msg); }
}

async function pickFile(onDataLoaded, showToast, t) {
  if (Platform.OS === "web") {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".csv";
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      try {
        const text = await file.text(); const parsed = parseCSV(text, t);
        if (parsed.error) { showToast("err", parsed.error); return; }
        onDataLoaded(parsed.data); showToast("ok", `${t.upload_ok} (${parsed.count})`);
      } catch { showToast("err", t.upload_err_web); }
    };
    input.click(); return;
  }
  if (!DocumentPicker) { showToast("err", "expo-document-picker requis"); return; }
  try {
    const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv","text/plain","*/*"] });
    if (res.canceled) return;
    const file = res.assets[0];
    const text = await fetch(file.uri).then((r) => r.text());
    const parsed = parseCSV(text, t);
    if (parsed.error) { showToast("err", parsed.error); return; }
    onDataLoaded(parsed.data); showToast("ok", `${t.upload_ok} (${parsed.count})`);
  } catch { showToast("err", t.upload_err_parse); }
}

// ─── Toast ────────────────────────────────────────────────────────────────
function Toast({ msg }) {
  if (!msg) return null;
  const isOk = msg.type === "ok";
  return (
    <View style={[styles.toast, {
      backgroundColor: isOk ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
      borderColor:     isOk ? "rgba(34,197,94,0.4)"  : "rgba(239,68,68,0.4)",
    }]}>
      <Text style={{ color: isOk ? T.green : T.red, fontSize: 13, fontWeight: "500", textAlign: "center" }}>{msg.text}</Text>
    </View>
  );
}
function useToast() {
  const [msg, setMsg] = useState(null);
  const timerRef = useRef(null);
  const showToast = useCallback((type, text) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMsg({ type, text });
    timerRef.current = setTimeout(() => setMsg(null), 3500);
  }, []);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return [msg, showToast];
}

// ─── Stats hook ───────────────────────────────────────────────────────────
function useDataStats(data) {
  return useMemo(() => {
    const entries = Object.values(data); const total = entries.length;
    if (total === 0) return { total: 0, byStatus: {}, topMotos: [], activeRatio: 0 };
    const byStatus = {};
    VALID_STATUSES.forEach((s) => { byStatus[s] = 0; });
    entries.forEach((e) => { if (byStatus[e.status] !== undefined) byStatus[e.status]++; });
    const motoCount = {};
    entries.forEach((e) => { const k = e.moto||"—"; motoCount[k] = (motoCount[k]||0) + 1; });
    const topMotos = Object.entries(motoCount).sort((a, b) => b[1]-a[1]).slice(0, 5).map(([moto, count]) => ({moto,count}));
    const active = (byStatus.under||0) + (byStatus.upfront||0);
    return { total, byStatus, topMotos, activeRatio: total > 0 ? Math.round((active/total)*100) : 0 };
  }, [data]);
}

// ─── StatusBadge ──────────────────────────────────────────────────────────
function StatusBadge({ status, t }) {
  const meta = STATUS_COLOR[status] || STATUS_COLOR.internal;
  return (
    <View style={[styles.badge, { backgroundColor: meta.bg, borderColor: meta.border }]}>
      <View style={[styles.badgeDot, { backgroundColor: meta.color }]} />
      <Text style={[styles.badgeText, { color: meta.color }]}>{getStatusLabel(status, t).toUpperCase()}</Text>
    </View>
  );
}

// ─── InfoRow ──────────────────────────────────────────────────────────────
function InfoRow({ label, value, mono, highlighted, highlight, last }) {
  return (
    <View style={[styles.infoRow, last && { borderBottomWidth: 0 }, highlight && { backgroundColor: "rgba(249,115,22,0.05)" }]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue,
        mono        && { fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace", fontSize: 12 },
        highlighted && { color: T.accent },
      ]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

// ─── ResultCard ───────────────────────────────────────────────────────────
function ResultCard({ motoKey, data, searchMode, t, isWide }) {
  if (!motoKey || !data) return null;
  const d = data[motoKey]; if (!d) return null;
  const isPlaque  = searchMode === "plaque";
  const isChassis = searchMode === "chassis";
  const foundLabel = isChassis
    ? `${t.found_via_chassis} : ${d.chassis}`
    : isPlaque ? `${t.found_via_plate} : ${d.plate}`
    : `${t.found_via_moto} : ${motoKey}`;

  return (
    <View style={styles.resultContainer}>
      <View style={styles.matchPill}>
        <Text style={styles.matchPillText}>🔍 {foundLabel}</Text>
      </View>
      <View style={styles.motoBadge}>
        <View style={{ flex: 1 }}>
          <Text style={styles.motoLabel}>{t.moto_label}</Text>
          <Text style={styles.motoKey}>{motoKey}</Text>
        </View>
        <Text style={{ fontSize: 28 }}>🏍️</Text>
      </View>
      <StatusBadge status={d.status} t={t} />
      {/* Sur tablette/desktop : 2 colonnes côte à côte */}
      <View style={isWide ? styles.resultRowWide : null}>
        <View style={isWide ? { flex: 1, marginRight: 8 } : null}>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t.section_client.toUpperCase()}</Text>
            <InfoRow label={t.row_name}  value={d.name}  />
            <InfoRow label={t.row_phone} value={d.phone} mono />
            <InfoRow label={t.row_date}  value={d.date}  last />
          </View>
        </View>
        <View style={isWide ? { flex: 1, marginLeft: 8 } : null}>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t.section_moto.toUpperCase()}</Text>
            <InfoRow label={t.row_plate}     value={d.plate}          mono highlight={isPlaque}  highlighted={isPlaque}  />
            <InfoRow label={t.row_chassis}   value={d.chassis || "—"} mono highlight={isChassis} highlighted={isChassis} />
            <InfoRow label={t.row_moto_type} value={d.moto} />
            <InfoRow label={t.row_status}    value={getStatusLabel(d.status, t)} last />
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── SlideModal — responsive ──────────────────────────────────────────────
// FIX : ajout de useResponsive + centrage + max-width sur tablette/desktop
function SlideModal({ visible, title, onClose, closeLabel, children }) {
  const { isWide, modalMaxWidth } = useResponsive();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
        {/* Bande de header */}
        <View style={[styles.modalHeader, isWide && { paddingHorizontal: 32 }]}>
          <Text style={styles.uploadTitle}>{title}</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>{closeLabel || "✕"}</Text>
          </TouchableOpacity>
        </View>
        {/* Corps centré sur wide */}
        <ScrollView
          contentContainerStyle={[
            { padding: 20, paddingBottom: 48 },
            isWide && modalMaxWidth && { maxWidth: modalMaxWidth, width: "100%", alignSelf: "center" },
          ]}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Upload Modal — responsive ────────────────────────────────────────────
function UploadModal({ visible, onClose, onDataLoaded, currentCount, data, t }) {
  const [toast, showToast] = useToast();
  const { isWide, modalMaxWidth } = useResponsive();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
        <ScrollView
          contentContainerStyle={[
            { padding: 20, paddingBottom: 48 },
            isWide && modalMaxWidth && { maxWidth: modalMaxWidth, width: "100%", alignSelf: "center" },
          ]}
        >
          <View style={styles.uploadHeader}>
            <View>
              <Text style={styles.uploadTitle}>{t.upload_title}</Text>
              <Text style={styles.uploadCount}>{currentCount} {t.upload_count}</Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>{t.upload_close}</Text>
            </TouchableOpacity>
          </View>
          <Toast msg={toast} />
          <TouchableOpacity
            style={[styles.dropZone, { marginTop: toast ? 12 : 0, marginBottom: 16 }]}
            onPress={() => pickFile(onDataLoaded, showToast, t)}
          >
            <Text style={{ fontSize: 36, marginBottom: 10 }}>📂</Text>
            <Text style={styles.dropTitle}>{t.upload_drop}</Text>
            <Text style={styles.dropSub}>{t.upload_click}</Text>
            <View style={styles.formatPill}><Text style={styles.formatPillText}>{t.upload_formats}</Text></View>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exportBtn} onPress={() => exportCSV(data, t)}>
            <Text style={styles.exportBtnText}>{t.export_btn}</Text>
          </TouchableOpacity>
          <View style={[styles.card, { marginBottom: 12, marginTop: 8 }]}>
            <Text style={styles.sectionTitle}>{t.upload_csv_guide.toUpperCase()}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator style={{ padding: 14 }}>
              <Text style={styles.codeBlock}>
                {"id,name,phone,date,plate,chassis,moto,status\n" +
                 "CM2211,Jean Dupont,+229 6 00 00 00,01 Jan 2024,AB 1234 C,VIN001ABC,COMMANDO,under\n" +
                 "DK9999,Awa Fall,+229 6 11 22 33,15 Mar 2023,XY 5678 D,VIN002DEF,CHAP CHAP,end"}
              </Text>
            </ScrollView>
          </View>
          <View style={[styles.card, { marginBottom: 12 }]}>
            <Text style={styles.sectionTitle}>{t.upload_status_values.toUpperCase()}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", padding: 12 }}>
              {Object.entries(STATUS_COLOR).map(([k, v]) => (
                <View key={k} style={[styles.statusChip, { backgroundColor: v.bg, borderColor: v.border, marginRight: 8, marginBottom: 8 }]}>
                  <Text style={[styles.statusChipText, { color: v.color }]}>{k}</Text>
                </View>
              ))}
            </View>
          </View>
          <TouchableOpacity style={styles.resetBtn} onPress={() => { onDataLoaded(DEFAULT_DATA); showToast("ok", t.upload_reset_ok); }}>
            <Text style={styles.resetBtnText}>{t.upload_reset}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Stats Modal ──────────────────────────────────────────────────────────
function StatsModal({ visible, onClose, stats, lastSync, t }) {
  if (!stats) {
    return (
    <SlideModal visible={visible} title={t.nav_stats} onClose={onClose} closeLabel={t.upload_close}>
      <Text style={{ color: "#999", textAlign: "center", marginTop: 20 }}>
        Chargement...
      </Text>
    </SlideModal>
    );
  }
const total = Number(stats.total) || 0;
const byStatus = stats?.byStatus || { 
  under: 0,
  end: 0,
  upfront: 0,
  internal: 0
};
  const PB = ({ value, color }) => (
    <View style={{ height: 6, backgroundColor: T.border, borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(value, 100)}%`, height: "100%", backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
  return (
    <SlideModal visible={visible} title={t.nav_stats} onClose={onClose} closeLabel={t.upload_close}>
      <View style={styles.pageHeader}>
        <View style={styles.pageHeaderIconWrap}><Text style={{ fontSize: 32 }}>📊</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.pageHeaderTitle}>{t.stats_header_title}</Text>
          <Text style={styles.pageHeaderSub}>{t.stats_header_sub}</Text>
        </View>
      </View>
      <View style={styles.divider} />
      <View style={styles.kpiCard}>
        <Text style={styles.kpiNumber}>{stats.total}</Text>
        <Text style={styles.kpiLabel}>{t.stats_total}</Text>
        <View style={[styles.soonChip, { marginTop: 8, backgroundColor: "rgba(249,115,22,0.1)", borderColor: "rgba(249,115,22,0.3)" }]}>
          <Text style={[styles.soonChipText, { color: T.accent }]}>{stats.activeRatio ?? Math.round( ((stats.byStatus?.under || 0) + (stats.byStatus?.upfront || 0)) / (stats.total || 1) * 100 )}% </Text>
        </View>
      </View>
      <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>{t.stats_by_status}</Text>
      <View style={styles.card}>
        {VALID_STATUSES.map((s, i) => {
          const meta = STATUS_COLOR[s]; const count = stats?.byStatus?.[s] || 0;
          const pct  = stats?.total > 0 ? Math.round((count/stats.total)*100) : 0;
          return (
            <View key={s} style={[styles.statRow, i === VALID_STATUSES.length-1 && { borderBottomWidth: 0 }]}>
              <View style={[styles.statDot, { backgroundColor: meta.color }]} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={styles.statLabel}>{getStatusLabel(s, t)}</Text>
                  <Text style={[styles.statCount, { color: meta.color }]}>{count} ({pct}%)</Text>
                </View>
                <PB value={pct} color={meta.color} />
              </View>
            </View>
          );
        })}
      </View>
      {stats.topMotos?.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 16, marginBottom: 8 }]}>{t.stats_by_moto}</Text>
          <View style={styles.card}>
            {stats.topMotos.map((item, i) => {
              const moto = item.moto;
              const count = item.count;
              const pct = stats.total > 0 ? Math.round((count/stats.total)*100) : 0;
              return (
                <View key={moto} style={[styles.statRow, i === stats.topMotos.length-1 && { borderBottomWidth: 0 }]}>
                  <Text style={[styles.statRank, { color: i === 0 ? T.accent : T.muted }]}>#{i+1}</Text>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={styles.statLabel}>{moto}</Text>
                      <Text style={styles.statCount}>{count} ({pct}%)</Text>
                    </View>
                    <View style={{ height: 4, backgroundColor: T.border, borderRadius: 2, marginTop: 5, overflow: "hidden" }}>
                      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: T.accent, borderRadius: 2, opacity: 0.6 }} />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        </>
      )}
      <Text style={[styles.sectionTitle, { marginTop: 16, marginBottom: 8 }]}>{t.stats_section_info}</Text>
      <View style={styles.card}>
        <InfoRow label={t.stats_avail_label} value={t.stats_avail_value} />
        <InfoRow label={t.stats_last_import} value={lastSync ? new Date(lastSync).toLocaleString() : t.sync_never} last />
      </View>
    </SlideModal>
  );
}

// ─── Change Password View ─────────────────────────────────────────────────
function ChangePasswordView({ user, onBack, t }) {
  const [curPw,  setCurPw]  = useState("");
  const [newPw,  setNewPw]  = useState("");
  const [confPw, setConfPw] = useState("");
  const [toast,  showToast] = useToast();

  const handleSave = async () => {
    if (newPw.length < 6) { showToast("err", t.params_chpw_mismatch); return; }
    if (newPw !== confPw)  { showToast("err", t.params_chpw_mismatch); return; }
    try {
      const cred = EmailAuthProvider.credential(`${user.id}@mototrack.local`, curPw);
      await reauthenticateWithCredential(auth.currentUser, cred);
      await updatePassword(auth.currentUser, newPw);
      showToast("ok", t.params_chpw_ok);
      setCurPw(""); setNewPw(""); setConfPw("");
    } catch {
      showToast("err", t.params_chpw_wrong_current);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Text style={styles.backBtnText}>{t.params_lang_back}</Text>
      </TouchableOpacity>
      <Text style={[styles.pageHeaderTitle, { marginBottom: 4 }]}>{t.params_chpw_title}</Text>
      <View style={styles.divider} />
      <Toast msg={toast} />
      <Text style={styles.fieldLabel}>{t.params_chpw_current.toUpperCase()}</Text>
      <TextInput value={curPw} onChangeText={setCurPw} placeholder="••••••••" placeholderTextColor={T.muted} secureTextEntry style={[styles.input, { marginBottom: 14 }]} />
      <Text style={styles.fieldLabel}>{t.params_chpw_new.toUpperCase()}</Text>
      <TextInput value={newPw} onChangeText={setNewPw} placeholder="••••••••" placeholderTextColor={T.muted} secureTextEntry style={[styles.input, { marginBottom: 14 }]} />
      <Text style={styles.fieldLabel}>{t.params_chpw_confirm.toUpperCase()}</Text>
      <TextInput value={confPw} onChangeText={setConfPw} placeholder="••••••••" placeholderTextColor={T.muted} secureTextEntry style={[styles.input, { marginBottom: 20 }]} />
      <TouchableOpacity style={[styles.loginBtn, { backgroundColor: T.blue }]} onPress={handleSave}>
        <Text style={styles.loginBtnText}>{t.params_chpw_btn}</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

function AboutView({ t, onBack }) {
  const year = new Date().getFullYear();
  return (
    <View>
      {/* Back */}
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Text style={styles.backBtnText}>{t.params_lang_back}</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.pageHeader}>
        <View style={styles.pageHeaderIconWrap}>
          <Text style={{ fontSize: 32 }}>🏍️</Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.pageHeaderTitle}>MotoTrack</Text>
          <Text style={styles.pageHeaderSub}>
            {t.about_version} {t.params_version_value}
          </Text>
        </View>
      </View>

      <View style={styles.divider} />

      {/* Description */}
      <View style={[styles.card, { padding: 16, marginBottom: 16 }]}>
        <Text style={{ color: T.text, fontSize: 14, lineHeight: 22 }}>
          {t.about_desc}
        </Text>
      </View>

      {/* Infos */}
      <View style={styles.card}>
        <View style={styles.settingsRow}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}>
              <Text>🏢</Text>
            </View>
            <View>              
            <Text style={styles.settingsLabel}>{t.about_dev}</Text>
            <Text style={styles.settingsSub}>{t.about_company}</Text>
            </View>
          </View>
        </View>


        <View style={[styles.settingsRow, { borderBottomWidth: 0 }]}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}>
              <Text>✉️</Text>
            </View>
            <View>             
              <Text style={styles.settingsLabel}>{t.about_contact}</Text>
                <Text style={styles.settingsSub}>{t.params_support_value}</Text>

            </View>
          </View>
        </View>
      </View>

      {/* Footer */}
      <Text style={{
        fontSize: 11,
        color: T.muted,
        textAlign: "center",
        marginTop: 16,
        opacity: 0.7,
      }}>
        {t.copyright.replace("{year}", year)}
      </Text>
    </View>
  );
}


// ─── Auto-logout Config View ──────────────────────────────────────────────
function AutoLogoutConfigView({ currentDelayMs, onSave, onBack, t }) {
  const currentMin = alMsToMin(currentDelayMs);
  const [selected, setSelected] = useState(currentMin);
  const [custom,   setCustom]   = useState("");
  const [toast,    showToast]   = useToast();

  const effectiveMin = useMemo(() => {
    const n = parseInt(custom, 10);
    if (custom.trim() && !isNaN(n) && n >= 1 && n <= 480) return n;
    return selected;
  }, [custom, selected]);

  const handleSave = () => {
    if (effectiveMin < 1 || effectiveMin > 480) { showToast("err", t.params_al_invalid); return; }
    onSave(alMinToMs(effectiveMin));
    showToast("ok", t.params_al_saved);
  };

  return (
    <View>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Text style={styles.backBtnText}>{t.params_lang_back}</Text>
      </TouchableOpacity>
      <Text style={[styles.pageHeaderTitle, { marginBottom: 4 }]}>{t.params_al_title}</Text>
      <Text style={[styles.pageHeaderSub, { marginBottom: 4 }]}>{t.params_al_sub}</Text>
      <Text style={[styles.pageHeaderDesc, { color: T.accent, marginBottom: 16 }]}>
        {t.params_al_current} {currentMin} {t.params_al_unit}
      </Text>
      <View style={styles.divider} />
      <Toast msg={toast} />
      <Text style={[styles.sectionTitle, { marginBottom: 12 }]}>{t.params_al_quick_select}</Text>
      <View style={styles.alGrid}>
        {AUTO_LOGOUT_OPTIONS_MIN.map((min) => {
          const isActive = selected === min && !custom.trim();
          return (
            <TouchableOpacity
              key={min}
              onPress={() => { setSelected(min); setCustom(""); }}
              style={[styles.alOptionBtn, isActive && { borderColor: T.accent, backgroundColor: "rgba(249,115,22,0.12)" }]}
            >
              <Text style={[styles.alOptionNum, isActive && { color: T.accent }]}>{min}</Text>
              <Text style={[styles.alOptionUnit, isActive && { color: T.accent }]}>{t.params_al_unit}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.sectionTitle, { marginTop: 8, marginBottom: 10 }]}>{t.params_al_custom}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 20 }}>
        <TextInput
          value={custom} onChangeText={setCustom}
          placeholder={t.params_al_custom_ph} placeholderTextColor={T.muted}
          keyboardType="numeric" maxLength={3}
          style={[styles.input, { flex: 1, marginRight: 12, marginBottom: 0 }]}
        />
        <Text style={{ color: T.muted, fontSize: 14 }}>{t.params_al_unit}</Text>
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 20 }]}>
        <InfoRow label={t.params_al_selected} value={`${effectiveMin} ${t.params_al_unit}`} last />
      </View>
      <TouchableOpacity style={[styles.loginBtn, { backgroundColor: T.accent }]} onPress={handleSave}>
        <Text style={styles.loginBtnText}>{t.params_al_save}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Params Modal ─────────────────────────────────────────────────────────
// FIX : view remis à "main" à chaque ouverture de la modale
function ParamsModal({ visible, onClose, lang, setLang, user, autoLogoutMs, onSaveAutoLogout, t }) {
  const [view, setView] = useState("main");

  // Réinitialise la sous-vue quand la modale se referme
  useEffect(() => { if (!visible) setView("main"); }, [visible]);

  if (view === "lang") {
    return (
      <SlideModal visible={visible} title={t.params_lang_picker_title} onClose={onClose} closeLabel={t.upload_close}>
        <Text style={[styles.pageHeaderDesc, { marginBottom: 20 }]}>{t.params_lang_picker_sub}</Text>
        {[{ code: "fr", flag: "🇫🇷", label: t.params_lang_fr, sub: "FR" },
          { code: "en", flag: "🇬🇧", label: t.params_lang_en, sub: "EN" }].map((l) => (
          <TouchableOpacity key={l.code} onPress={() => { setLang(l.code); setView("main"); }}
            style={[styles.langChoiceBtn, lang === l.code && styles.langChoiceBtnActive]}>
            <Text style={{ fontSize: 28 }}>{l.flag}</Text>
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={[styles.langChoiceLabel, lang === l.code && { color: T.accent }]}>{l.label}</Text>
              <Text style={styles.langChoiceSub}>{l.sub}</Text>
            </View>
            {lang === l.code && <View style={styles.langCheckBadge}><Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>✓</Text></View>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.resetBtn, { marginTop: 20 }]} onPress={() => setView("main")}>
          <Text style={styles.resetBtnText}>{t.params_lang_back}</Text>
        </TouchableOpacity>
      </SlideModal>
    );
  }

  if (view === "chpw") {
    return (
      <SlideModal visible={visible} title={t.params_chpw_title} onClose={onClose} closeLabel={t.upload_close}>
        <ChangePasswordView user={user} onBack={() => setView("main")} t={t} />
      </SlideModal>
    );
  }

  if (view === "autologout") {
    return (
      <SlideModal visible={visible} title={t.params_al_title} onClose={onClose} closeLabel={t.upload_close}>
        <AutoLogoutConfigView currentDelayMs={autoLogoutMs} onSave={(ms) => onSaveAutoLogout(ms)} onBack={() => setView("main")} t={t} />
      </SlideModal>
    );
  }

  if (view === "about") {
  return (
    <SlideModal visible={visible} title={t.about_title} onClose={onClose} closeLabel={t.upload_close}>
      <AboutView t={t} onBack={() => setView("main")} />
    </SlideModal>
   );
  }

  const alLabel = `${alMsToMin(autoLogoutMs)} ${t.params_al_unit} ${t.params_al_inactivity}`;
  return (
    <SlideModal visible={visible} title={t.nav_params} onClose={onClose} closeLabel={t.upload_close}>
      <View style={styles.pageHeader}>
        <View style={styles.pageHeaderIconWrap}><Text style={{ fontSize: 32 }}>⚙️</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.pageHeaderTitle}>{t.params_header_title}</Text>
          <Text style={styles.pageHeaderSub}>{t.params_header_sub}</Text>
        </View>
      </View>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>{t.params_lang_section}</Text>
      <View style={[styles.card, { marginTop: 8, marginBottom: 20 }]}>
        <TouchableOpacity style={[styles.settingsRow, { borderBottomWidth: 0 }]} onPress={() => setView("lang")}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}><Text style={{ fontSize: 18 }}>{lang === "fr" ? "🇫🇷" : "🇬🇧"}</Text></View>
            <View>
              <Text style={styles.settingsLabel}>{t.params_lang_label}</Text>
              <Text style={styles.settingsSub}>{lang === "fr" ? t.params_lang_fr : t.params_lang_en}</Text>
            </View>
          </View>
          <Text style={[styles.infoValue, { color: T.accent, flex: 0 }]}>{t.params_lang_action}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.sectionTitle}>{t.params_security_section}</Text>
      <View style={[styles.card, { marginTop: 8, marginBottom: 20 }]}>
        <TouchableOpacity style={styles.settingsRow} onPress={() => setView("chpw")}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}><Text style={{ fontSize: 18 }}>🔐</Text></View>
            <View>
              <Text style={styles.settingsLabel}>{t.params_chpw_label}</Text>
              <Text style={styles.settingsSub}>{t.params_chpw_action}</Text>
            </View>
          </View>
          <Text style={[styles.infoValue, { color: T.accent, flex: 0 }]}>→</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.settingsRow} onPress={() => setView("autologout")}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}><Text style={{ fontSize: 18 }}>⏱️</Text></View>
            <View>
              <Text style={styles.settingsLabel}>{t.params_auto_logout_label}</Text>
              <Text style={[styles.settingsSub, { color: T.accent }]}>{alLabel}</Text>
            </View>
          </View>
          <Text style={[styles.infoValue, { color: T.accent, flex: 0 }]}>{t.params_auto_logout_action}</Text>
        </TouchableOpacity>
        <View style={[styles.settingsRow, { borderBottomWidth: 0 }]}>
          <View style={styles.settingsRowLeft}>
            <View style={styles.settingsIconWrap}><Text style={{ fontSize: 18 }}>🔑</Text></View>
            <View>
              <Text style={styles.settingsLabel}>{t.params_pin_label}</Text>
              <Text style={styles.settingsSub}>{t.params_pin_value}</Text>
            </View>
          </View>
          <View style={styles.soonChip}><Text style={styles.soonChipText}>{t.params_soon}</Text></View>
        </View>
      </View>
      <Text style={styles.sectionTitle}>{t.params_app_section}</Text>
        
<View style={[styles.card, { marginTop: 8 }]}>

  {/* Version */}
  <View style={styles.settingsRow}>
    <View style={styles.settingsRowLeft}>
      <View style={styles.settingsIconWrap}>
        <Text style={{ fontSize: 18 }}>📱</Text>
      </View>
      <View>
        <Text style={styles.settingsLabel}>{t.params_version_label}</Text>
        <Text style={styles.settingsSub}>{t.params_version_value}</Text>
      </View>
    </View>
  </View>

  {/* Support */}
  <View style={styles.settingsRow}>
    <View style={styles.settingsRowLeft}>
      <View style={styles.settingsIconWrap}>
        <Text style={{ fontSize: 18 }}>✉️</Text>
      </View>
      <View>
        <Text style={styles.settingsLabel}>{t.params_support_label}</Text>
        <Text style={styles.settingsSub}>{t.params_support_value}</Text>
      </View>
    </View>
  </View>

  {/* About */}
  <TouchableOpacity
    style={[styles.settingsRow, { borderBottomWidth: 0 }]}
    onPress={() => setView("about")} >
    <View style={styles.settingsRowLeft}>
      <View style={styles.settingsIconWrap}>
        <Text style={{ fontSize: 18 }}>ℹ️</Text>
      </View>
      <View>
        <Text style={styles.settingsLabel}>{t.about_title}</Text>
        <Text style={styles.settingsSub}>{t.about_sub}</Text>
      </View>
    </View>
    <Text style={[styles.infoValue, { color: T.accent, flex: 0 }]}>→</Text>
  </TouchableOpacity>
</View>
    </SlideModal>
  );
}

// ─── Admin Modal ──────────────────────────────────────────────────────────
function AdminModal({ visible, onClose, user, agents, onToggleAgent, onChangeRole, onDeleteAgent, t }) {
  const [toast, showToast] = useToast();
  const isAdmin = user?.role === ROLES.admin;

  const getRoleLabel = (r) =>
    r === ROLES.admin ? t.adm_role_admin
    : r === ROLES.supervisor ? t.adm_role_supervisor
    : t.adm_role_agent;

  const handleDelete = (ag) => {
    Alert.alert(t.adm_delete_confirm, t.adm_delete_confirm_msg, [
      { text: t.btn_back, style: "cancel" },
      { text: t.adm_delete, style: "destructive", onPress: () => onDeleteAgent(ag.id) },
    ]);
  };

  return (
    <SlideModal visible={visible} title={t.nav_admin} onClose={onClose} closeLabel={t.upload_close}>
      <View style={styles.pageHeader}>
        <View style={styles.pageHeaderIconWrap}><Text style={{ fontSize: 32 }}>🛠️</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.pageHeaderTitle}>{t.adm_title}</Text>
          <Text style={styles.pageHeaderSub}>{t.adm_sub}</Text>
        </View>
      </View>
      <View style={styles.divider} />
      <Toast msg={toast} />
      <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>{t.adm_section_agents.toUpperCase()}</Text>
      {agents.length === 0 ? (
        <View style={[styles.card, { padding: 16 }]}>
          <Text style={{ color: T.muted, fontSize: 13, textAlign: "center" }}>{t.adm_no_agents}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {agents.map((ag, idx) => {
            const isActive      = ag.active !== false;
            const roleColor     = ROLE_COLOR[ag.role] || T.blue;
            const canModify     = (isAdmin && ag.role !== ROLES.admin && ag.id !== user.id) || (user?.role === ROLES.supervisor && ag.role === ROLES.agent);
            const canChangeRole = isAdmin && ag.id !== user.id && ag.role !== ROLES.admin;
            return (
              <View key={ag.id} style={[styles.admAgentRow, idx === agents.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.admAgentId}>{ag.id}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 4, gap: 6 }}>
                    <TouchableOpacity
                      disabled={!canChangeRole}
                      onPress={() => {
                        const next = ag.role === ROLES.agent ? ROLES.supervisor : ROLES.agent;
                        onChangeRole(ag.id, next);
                      }}
                      style={[styles.admRoleBadge, { borderColor: roleColor, opacity: canChangeRole ? 1 : 0.4 }]}
                    >
                      <Text style={{ fontSize: 10, color: roleColor, fontWeight: "600" }}>
                        {getRoleLabel(ag.role)}{canChangeRole ? " ↕" : ""}
                      </Text>
                    </TouchableOpacity>
                    <View style={[styles.admRoleBadge, { borderColor: isActive ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)" }]}>
                      <Text style={{ fontSize: 10, color: isActive ? T.green : T.red, fontWeight: "600" }}>
                        {isActive ? t.adm_status_active : t.adm_status_inactive}
                      </Text>
                    </View>
                  </View>
                </View>
                {canModify && (
                  <View style={{ flexDirection: "row", flexShrink: 0, marginLeft: 8 }}>
                    <TouchableOpacity
                      onPress={() => onToggleAgent(ag.id)}
                      style={[styles.admActionBtn, {
                        backgroundColor: isActive ? "rgba(239,68,68,0.08)" : "rgba(34,197,94,0.08)",
                        borderColor:     isActive ? "rgba(239,68,68,0.3)"  : "rgba(34,197,94,0.3)",
                      }]}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "600", color: isActive ? T.red : T.green }}>
                        {isActive ? t.adm_deactivate : t.adm_activate}
                      </Text>
                    </TouchableOpacity>
                    {isAdmin && (
                      <TouchableOpacity
                        onPress={() => handleDelete(ag)}
                        style={[styles.admActionBtn, { marginLeft: 6, backgroundColor: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.25)" }]}
                      >
                        <Text style={{ fontSize: 11, fontWeight: "600", color: T.red }}>🗑</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </SlideModal>
  );
}

// ─── Language Switcher ────────────────────────────────────────────────────
function LangSwitcher({ lang, setLang }) {
  return (
    <View style={styles.langRow}>
      {["fr", "en"].map((l) => (
        <TouchableOpacity key={l} onPress={() => setLang(l)} style={[styles.langBtn, lang === l && styles.langBtnActive]}>
          <Text style={[styles.langBtnText, lang === l && styles.langBtnTextActive]}>
            {l === "fr" ? "🇫🇷 FR" : "🇬🇧 EN"}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Login Screen — responsive ────────────────────────────────────────────
// Mobile  : plein écran, pas de card (inchangé)
// Desktop/tablette : card centrée sur fond noir comme sur la maquette
function LoginScreen({ onLogin, lang, setLang, t }) {
  const [loginId,    setLoginId]    = useState("");
  const [password,   setPassword]   = useState("");
  const [loginToast, showLoginToast] = useToast();
  const { isMobile } = useResponsive();

  const handleLogin = () => {
    const id = loginId.trim(); const pw = password.trim();
    if (!id || !pw) { showLoginToast("err", t.fields_required); return; }
    onLogin(id, pw, showLoginToast);
  };

  // ── MOBILE : affichage plein écran inchangé ────────────────────────────
  if (isMobile) {
    return (
      <SafeAreaView style={styles.loginSafe}>
        <StatusBar barStyle="light-content" backgroundColor={T.bg} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 28 }} keyboardShouldPersistTaps="handled">
            <LangSwitcher lang={lang} setLang={setLang} />
            <View style={{ flex: 1, justifyContent: "center" }}>
              <View style={styles.logoWrap}>
                <View style={styles.logoIcon}><Text style={{ fontSize: 36 }}>🏍️</Text></View>
                <Text style={styles.logoText}>Moto<Text style={{ color: T.accent }}>Track</Text></Text>
                <Text style={styles.logoTagline}>{t.tagline}</Text>
              </View>
              <Text style={styles.fieldLabel}>{t.login_id.toUpperCase()}</Text>
              <TextInput value={loginId} onChangeText={setLoginId} placeholder={t.login_id_ph}
                placeholderTextColor={T.muted} autoCapitalize="none" returnKeyType="next"
                style={[styles.input, { marginBottom: 14 }]} />
              <Text style={styles.fieldLabel}>{t.login_pw.toUpperCase()}</Text>
              <TextInput value={password} onChangeText={setPassword} placeholder="••••••••"
                placeholderTextColor={T.muted} secureTextEntry returnKeyType="done"
                onSubmitEditing={handleLogin} style={[styles.input, { marginBottom: 20 }]} />
              <Toast msg={loginToast} />
              <TouchableOpacity style={[styles.loginBtn, loginToast && { marginTop: 12 }]} onPress={handleLogin}>
                <Text style={styles.loginBtnText}>{t.login_btn}</Text>
              </TouchableOpacity>
            </View>
             <View style={{ marginTop: 40 }}> 
            <Text style={{ fontSize: 11, color: T.muted, opacity: 0.9, textAlign: "center", marginTop: 20,}}>
            {t.copyright.replace("{year}", new Date().getFullYear())}
              </Text>
              </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── DESKTOP / TABLETTE : card centrée sur fond noir (comme la maquette) ─
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#050709" }}>
      <StatusBar barStyle="light-content" backgroundColor="#050709" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Card exactement comme la maquette */}
          <View style={{
            width: 420,
            backgroundColor: T.bg,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: T.border,
            padding: 40,
            shadowColor: "#000",
            shadowOpacity: 0.6,
            shadowRadius: 40,
            elevation: 24,
          }}>
            <LangSwitcher lang={lang} setLang={setLang} />
            <View style={styles.logoWrap}>
              <View style={styles.logoIcon}><Text style={{ fontSize: 36 }}>🏍️</Text></View>
              <Text style={styles.logoText}>Moto<Text style={{ color: T.accent }}>Track</Text></Text>
              <Text style={styles.logoTagline}>{t.tagline}</Text>
            </View>
            <Text style={styles.fieldLabel}>{t.login_id.toUpperCase()}</Text>
            <TextInput value={loginId} onChangeText={setLoginId} placeholder={t.login_id_ph}
              placeholderTextColor={T.muted} autoCapitalize="none" returnKeyType="next"
              style={[styles.input, { marginBottom: 14 }]} />
            <Text style={styles.fieldLabel}>{t.login_pw.toUpperCase()}</Text>
            <TextInput value={password} onChangeText={setPassword} placeholder="••••••••"
              placeholderTextColor={T.muted} secureTextEntry returnKeyType="done"
              onSubmitEditing={handleLogin} style={[styles.input, { marginBottom: 20 }]} />
            <Toast msg={loginToast} />
            <TouchableOpacity style={[styles.loginBtn, loginToast && { marginTop: 12 }]} onPress={handleLogin}>
              <Text style={styles.loginBtnText}>{t.login_btn}</Text>
            </TouchableOpacity>
          </View>
          {/* Copyright */}
          <View style={{ marginTop: 18 }}>
            <Text style={{ fontSize: 11, color: T.muted, opacity: 0.9, textAlign: "center", }} >
           {t.copyright.replace("{year}", new Date().getFullYear())}
               </Text>
              </View>      
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Firestore batch util ─────────────────────────────────────────────────
async function commitInBatches(items, handler, batchSize = 400) {
  let batch = writeBatch(db); let count = 0;
  for (const item of items) {
    handler(batch, item); count++;
    if (count === batchSize) { await batch.commit(); batch = writeBatch(db); count = 0; }
  }
  if (count > 0) await batch.commit();
}

async function wipeMotosCollection() {
  const snap = await getDocs(collection(db, "motos"));
  const ids  = snap.docs.map((d) => d.id);
  await commitInBatches(ids, (batch, id) => { batch.delete(doc(db, "motos", id)); });
}


async function importMotosData(dataObject) {
  const entries = Object.entries(dataObject);

  let total = 0;
  const byStatus = {
    under: 0,
    end: 0,
    upfront: 0,
    internal: 0,
  };
  const motoCount = {};
  
  //  lire Firestore
  const snap = await getDocs(collection(db, "motos"));
  const existingIds = snap.docs.map(d => d.id);

  //  lire CSV
  const newIds = entries.map(([k]) => sanitize(k).toUpperCase());
  
  // sécurité
  if (newIds.length === 0) {
  throw new Error("Import annulé: CSV vide");
  }
  
  // détecter et supprimer les anciennes
  const newIdsSet = new Set(newIds);
  const toDelete = existingIds.filter(id => !newIdsSet.has(id));

  // DEBUG IMPORT
  console.log("Import:", { totalCSV: newIds.length, existing: existingIds.length, toDelete: toDelete.length, });

  // ajouter + modifier
  await commitInBatches(entries, (batch, [k, v]) => {
    const id = sanitize(k).toUpperCase();
    
    const normalize = (s) =>
      String(s || "")
        .toUpperCase()
        .trim()
        .replace(/\s+/g, " ");

    const status = VALID_STATUSES.includes(v.status)
      ? v.status
      : "internal";

    // statistiques
    total++;
    if (byStatus[status] !== undefined) {
      byStatus[status]++;
    }

    const motoName = sanitize(v.moto) || "UNKNOWN";
    motoCount[motoName] = (motoCount[motoName] || 0) + 1;

    batch.set(doc(db, "motos", id), {
      name: sanitize(v.name),
      phone: sanitize(v.phone),
      date: sanitize(v.date || "—"),
      plate: normalize(v.plate),
      chassis: normalize(v.chassis || "—"),
      moto: sanitize(v.moto || "—"),
      status,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });
  
  // supprimer ensuite
  await commitInBatches(toDelete, (batch, id) => {
    batch.delete(doc(db, "motos", id));
  });
  
  const topMotos = Object.entries(motoCount)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([moto, count]) => ({
    moto,
    count
  }));


  const active = (byStatus.under || 0) + (byStatus.upfront || 0);

  const activeRatio = total > 0
  ? Math.round((active / total) * 100)
  : 0;

  // mettre à jour stats
  await setDoc(doc(db, "stats", "global"), {
    total,
    byStatus,
    topMotos,
    activeRatio,
    updatedAt: serverTimestamp(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function MotoTrack() {
  const [lang,            setLang]            = useState("fr");
  const [screen,          setScreen]          = useState("login");
  const [authLoading,     setAuthLoading]     = useState(true);  // FIX: attend Firebase Auth avant d'afficher
  const [mode,            setMode]            = useState("moto");
  const [user,            setUser]            = useState(null);
  const [agents,          setAgents]          = useState([]);
  const [query,           setQuery]           = useState("");
  const [result,          setResult]          = useState(null);
  const [data,            setData]            = useState({});
  const [showUpload,      setShowUpload]      = useState(false);
  const [showStats,       setShowStats]       = useState(false);
  const [showParams,      setShowParams]      = useState(false);
  const [showAdmin,       setShowAdmin]       = useState(false);
  const [activeNav,       setActiveNav]       = useState("search");
  const [emptyState,      setEmptyState]      = useState({ icon: "🏍️", text: null });
  const [lastSync,        setLastSync]        = useState(null);
  const [globalToast,     showGlobalToast_]   = useToast();
  const [syncUpdateAvail, setSyncUpdateAvailable] = useState(false);

  const t = getT(lang);
  const { isMobile, isWide, appWidth, contentMaxWidth } = useResponsive();

  // ─── Firestore listeners ─────────────────────────────────────────────

  // LISTENER MOTOS (compteur réel)
useEffect(() => {
  if (!user) return;

  const unsub = onSnapshot(
    collection(db, "motos"),
    (snap) => {
      const obj = {};

      snap.docs.forEach((d) => {
        obj[d.id] = d.data();
      });

      console.log("✅ MOTOS:", snap.size);

      setData(obj);
      console.log("DATA COUNT:", Object.keys(obj).length);
    },
    (err) => console.error("❌ motos snapshot:", err)
  );

  return () => unsub();
}, [user]);
  
  useEffect(() => {
    if (!user?.role) return;
    if (user.role !== ROLES.admin && user.role !== ROLES.supervisor) return;
    const unsub = onSnapshot(
      collection(db, "users"),
      (snap) => setAgents(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err)  => console.error("❌ users snapshot:", err.code)
    );
    return () => unsub();
  }, [user]);

  const [stats, setStats] = useState(null);
  const liveStats = useDataStats(data);

useEffect(() => {
  if (!user) return;

  const unsub = onSnapshot(
    doc(db, "stats", "global"),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setStats(data);

        // sync multi-user
  const ts = data.updatedAt?.toMillis
  ? data.updatedAt.toMillis() : Date.now();
    setLastSync(ts);
    setSyncTs(ts);
      }
    },
    (err) => console.error("❌ stats snapshot:", err)
  );

  return () => unsub();
}, [user]);
  
  const showGlobalToast = useCallback((type, text) => showGlobalToast_(type, text), [showGlobalToast_]);

  // ─── FIX REFRESH : restaure la session depuis Firebase Auth au rechargement ──
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // L'utilisateur est déjà connecté (session Firebase persistée)
        try {
          const uid = firebaseUser.email.split("@")[0];
          const snap = await getDoc(doc(db, "users", uid));
          if (snap.exists() && snap.data().active !== false) {
            setUser({ id: snap.id, name: snap.data().name, role: snap.data().role, email: firebaseUser.email });
            setScreen("main");
          } else {
            // Compte désactivé ou supprimé
            await signOut(auth);
            setScreen("login");
          }
        } catch {
          setScreen("login");
        }
      } else {
        setScreen("login");
      }
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  // ─── Auto-logout ──────────────────────────────────────────────────────
  const [autoLogoutMs, setAutoLogoutMs] = useState(() => {
    const stored = lsGet(SYNC_KEY_AL);
    return stored ? parseInt(stored, 10) : alMinToMs(DEFAULT_AL_MIN);
  });
  const handleSaveAutoLogout = useCallback((ms) => { setAutoLogoutMs(ms); lsSet(SYNC_KEY_AL, ms); }, []);

  // ─── FIX DÉCONNEXION : finally garantit le retour login même si signOut échoue ──
  const handleLogout = useCallback(async () => {
    try { await signOut(auth); } catch (e) { console.warn("signOut error:", e); }
    finally {
      setUser(null);
      setScreen("login");
      setStats(null);
      setAgents([]);
      setData({});
      setQuery(""); setResult(null);
      setEmptyState({ icon: "🏍️", text: null });
      setMode("moto"); setActiveNav("search");
      setShowUpload(false); setShowStats(false);
      setShowParams(false); setShowAdmin(false);
    }
  }, []);

  const autoLogoutActive = screen === "main";
  useAutoLogout(autoLogoutActive, autoLogoutMs, handleLogout, showGlobalToast, t.auto_logout_warning);

  useSyncWatcher(lastSync, useCallback((newTs) => {
    setSyncUpdateAvailable(true); setSyncTs(newTs);
  }, []));


  const syncStale = useMemo(() => lastSync ? Date.now() - lastSync > 24 * 60 * 60 * 1000 : false, [lastSync]);

  const resetSearch = useCallback(() => {
    setQuery(""); setResult(null);
    setEmptyState({ icon: "🏍️", text: null });
    setMode("moto"); setActiveNav("search");
  }, []);

  const switchMode = (m) => { setMode(m); setQuery(""); setResult(null); setEmptyState({ icon: "🏍️", text: null }); };

  const doSearch = useCallback(async () => {
  const normalize = (s) => String(s || "") .toUpperCase()  .trim()  .replace(/\s+/g, " ");
  const raw = normalize(query);
  if (!raw) return;
  try {
    let found = null;
    
    // ✅ 1. recherche par ID (ultra rapide)
    if (mode === "moto") { const docSnap = await getDoc(doc(db, "motos", raw));
      if (docSnap.exists()) { found = { key: raw, data: docSnap.data() }; }
    }

    // ✅ 2. recherche par plaque
    if (!found && mode === "plaque") {
      const snap = await getDocs( fsQuery( collection(db, "motos"), 
        where("plate", "==", raw) ) );
      if (!snap.empty) {
        const d = snap.docs[0]; found = { key: d.id, data: d.data() };}
    }

    // ✅ 3. recherche par chassis
    if (!found && mode === "chassis") {
      const snap = await getDocs( fsQuery( collection(db, "motos"), 
        where("chassis", "==", raw) ));
      if (!snap.empty) {
        const d = snap.docs[0]; found = { key: d.id, data: d.data() };}
    }

    // ✅ résultat final
    if (found) {
      setResult(found); setEmptyState({ icon: "🏍️", text: null }); } 
    else {
      setResult(null);
      setEmptyState({ icon: "❌", text: raw }); }
  } catch (error) {
    console.error("SEARCH ERROR:", error);
  }}, [query, mode]);

  const handleDataLoaded = useCallback(async (d) => {
    try {
      showGlobalToast("ok", "⬆ Mise à jour en cours…");
      await importMotosData(d);
      const now = Date.now();
      setLastSync(now); 
      setSyncTs(now); 
      setSyncUpdateAvailable(false);
      resetSearch();
      showGlobalToast("ok", t.import_success);
    } catch (err) {
      console.error("IMPORT ERROR:", err);
      showGlobalToast("err", t.import_error);
    }
  }, [resetSearch, showGlobalToast, t]);

  const handleLogin = useCallback(async (id, pw, showToast) => {
    try {
      const cleanId = id.toLowerCase().trim();
      const email   = `${cleanId}@mototrack.local`;
      await signInWithEmailAndPassword(auth, email, pw.trim());
      const snap = await getDoc(doc(db, "users", cleanId));
      if (!snap.exists()) { showToast("err", t.invalid_creds); await signOut(auth); return; }
      const profile = { id: snap.id, ...snap.data() };
      if (profile.active === false) { showToast("err", t.invalid_creds); await signOut(auth); return; }
      setUser({ id: profile.id, name: profile.name, role: profile.role, email });
      setScreen("main");
    } catch { showToast("err", t.invalid_creds); }
  }, [t.invalid_creds]);

  const toggleAgent = useCallback(async (id) => {
    const ag = agents.find((a) => a.id === id); if (!ag) return;
    // Un admin ne peut pas désactiver un autre admin ni son propre compte
    if (ag.role === ROLES.admin || id === user.id) { Alert.alert(t.error, t.err_toggle); return; }
    try { await updateDoc(doc(db, "users", id), { active: ag.active === false }); }
    catch (e) { console.error("TOGGLE:", e); Alert.alert(t.error, t.err_toggle); }
  }, [agents, user, t]);

  const changeAgentRole = useCallback(async (id, newRole) => {
    if (id === user.id) { Alert.alert(t.error, t.err_role); return; }
    if (!Object.values(ROLES).includes(newRole)) return;
    try { await updateDoc(doc(db, "users", id), { role: newRole }); }
    catch { Alert.alert(t.error, t.err_role); }
  }, [user, t]);

  const deleteAgent = useCallback(async (id) => {
    try {
      if (id === user.id) { Alert.alert(t.error, t.err_cannot_delete_self); return; }
      const ref  = doc(db, "users", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) return;
      if (snap.data().role === ROLES.admin) { Alert.alert(t.error, t.err_cannot_delete_admin); return; }
      await deleteDoc(ref);
    } catch (e) { console.error("DELETE:", e); Alert.alert(t.error, t.err_delete); }
  }, [user, t]);

  // ─── Routing ──────────────────────────────────────────────────────────
  // Attendre que Firebase Auth ait vérifié la session avant de rendre quoi que ce soit
  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 36, marginBottom: 16 }}>🏍️</Text>
        <Text style={{ color: T.muted, fontSize: 13 }}>MotoTrack</Text>
      </View>
    );
  }

  if (screen === "login") {
    return <LoginScreen onLogin={handleLogin} lang={lang} setLang={setLang} t={t} />;
  }

  const canAdmin  = user?.role === ROLES.admin || user?.role === ROLES.supervisor;
  const canUpload = can(user, "upload");

  const currentPlaceholder = mode === "chassis" ? t.ph_chassis : mode === "plaque" ? t.ph_plate : t.ph_moto;
  const currentEmptyLabel  = mode === "chassis" ? t.empty_default_chassis : mode === "plaque" ? t.empty_default_plate : t.empty_default_moto;

  const navItems = [
    { id: "search", icon: "🔍", label: t.nav_search },
    ...(canUpload ? [{ id: "upload", icon: "📤", label: t.nav_upload }] : []),
    { id: "stats",  icon: "📊", label: t.nav_stats  },
    ...(canAdmin  ? [{ id: "admin",  icon: "🛠️", label: t.nav_admin  }] : []),
    { id: "params", icon: "⚙️", label: t.nav_params },
  ];

  const roleBadgeColor = ROLE_COLOR[user?.role] || T.blue;
  const roleBadgeLabel = t[`role_${user?.role}`] || (user?.role || "").toUpperCase();

  return (
    <View style={[styles.appRoot, !isMobile && { backgroundColor: T.bg }]}>
      <View style={styles.appInner}>
        <SafeAreaView style={styles.safe}>
          <StatusBar barStyle="light-content" backgroundColor={T.surface} />

          {/* Toast global flottant */}
          {globalToast && (
            <View style={{ position: "absolute", top: 60, left: 16, right: 16, zIndex: 999 }}>
              <Toast msg={globalToast} />
            </View>
          )}

          <UploadModal visible={showUpload} onClose={() => { setShowUpload(false); setActiveNav("search"); }}
            onDataLoaded={handleDataLoaded} currentCount={stats?.total && stats.total > 0 ? stats.total : Object.keys(data).length} data={data} t={t} />
          <StatsModal  visible={showStats}  onClose={() => { setShowStats(false);  setActiveNav("search"); }}
            stats={stats ?? liveStats} lastSync={lastSync} t={t} />
          <ParamsModal visible={showParams} onClose={() => { setShowParams(false); setActiveNav("search"); }}
            lang={lang} setLang={setLang} user={user}
            autoLogoutMs={autoLogoutMs} onSaveAutoLogout={handleSaveAutoLogout} t={t} />
          {canAdmin && (
            <AdminModal visible={showAdmin} onClose={() => { setShowAdmin(false); setActiveNav("search"); }}
              user={user} agents={agents}
              onToggleAgent={toggleAgent} onChangeRole={changeAgentRole} onDeleteAgent={deleteAgent} t={t} />
          )}

          {/* ─── HEADER ────────────────────────────────────────────── */}
          <View style={styles.header}>
            <View style={styles.headerInner}>

              {/* Ligne 1 : logo + actions */}
              <View style={styles.headerTop}>
                <View style={styles.headerLogo}>
                  <View style={styles.headerIcon}><Text style={{ fontSize: 16 }}>🏍️</Text></View>
                  <View>
                    <Text style={styles.headerTitle}>Moto<Text style={{ color: T.accent }}>Track</Text></Text>
                    {user?.role && (
                      <View style={{ backgroundColor: roleBadgeColor, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginTop: 3, alignSelf: "flex-start" }}>
                        <Text style={{ fontSize: 10, color: "#fff", fontWeight: "700", letterSpacing: 0.5 }}>{roleBadgeLabel}</Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* Actions à droite — sur mobile : juste logout, sur wide : sync + lang + logout */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {isWide && syncStale   && <Text style={{ fontSize: 10, color: T.yellow }}>{t.sync_stale}</Text>}
                  {isWide && syncUpdateAvail && <Text style={{ fontSize: 10, color: T.green }}>{t.sync_update_available}</Text>}
                  {isWide && <LangSwitcher lang={lang} setLang={setLang} />}
                  <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
                    <Text style={styles.logoutText}>{isMobile ? "⏏" : t.logout}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Indicateurs sync sur mobile (sous le header) */}
              {isMobile && (syncStale || syncUpdateAvail) && (
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  {syncStale       && <Text style={{ fontSize: 10, color: T.yellow }}>{t.sync_stale}</Text>}
                  {syncUpdateAvail && <Text style={{ fontSize: 10, color: T.green  }}>{t.sync_update_available}</Text>}
                </View>
              )}

              {/* Onglets de recherche */}
              {isWide ? (
                <View style={[styles.tabs, { flexDirection: "row", marginBottom: 12 }]}>
                  {[{ id: "moto", label: t.tab_moto }, { id: "plaque", label: t.tab_plate }, { id: "chassis", label: t.tab_chassis }].map((tab) => (
                    <TouchableOpacity key={tab.id} style={[styles.tab, styles.tabWide, mode === tab.id && styles.tabActive]} onPress={() => switchMode(tab.id)}>
                      <Text style={[styles.tabText, mode === tab.id && styles.tabTextActive]}>{tab.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <View style={[styles.tabs, { flexDirection: "row" }]}>
                    {[{ id: "moto", label: t.tab_moto }, { id: "plaque", label: t.tab_plate }, { id: "chassis", label: t.tab_chassis }].map((tab) => (
                      <TouchableOpacity key={tab.id} style={[styles.tab, { paddingHorizontal: 14 }, mode === tab.id && styles.tabActive]} onPress={() => switchMode(tab.id)}>
                        <Text style={[styles.tabText, mode === tab.id && styles.tabTextActive]}>{tab.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              )}

              {/* Barre de recherche */}
              <View style={styles.searchRow}>
                <TextInput
                  value={query} onChangeText={setQuery} onSubmitEditing={doSearch}
                  placeholder={currentPlaceholder} placeholderTextColor={T.muted}
                  style={[styles.searchInput, isWide && { fontSize: 16, paddingVertical: 14 }]}
                  autoCapitalize="characters" maxLength={25} returnKeyType="search"
                />
                <TouchableOpacity style={[styles.searchBtn, isWide && { width: 52, borderRadius: 14 }]} onPress={doSearch}>
                  <Text style={{ fontSize: isWide ? 18 : 16 }}>🔍</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* ─── CONTENU ───────────────────────────────────────────── */}
          <ScrollView
            style={styles.content}
            contentContainerStyle={[
              styles.contentContainer,
            ]}
            keyboardShouldPersistTaps="handled"
          >
            {!result ? (
              <View style={[styles.emptyState, isWide && { paddingTop: 120 }]}>
                <Text style={[styles.emptyIcon, isWide && { fontSize: 64 }]}>{emptyState.icon}</Text>
                <Text style={[styles.emptyText, isWide && { fontSize: 16, maxWidth: 320 }]}>
                  {emptyState.text
                    ? <>{t.empty_noresult}{" "}<Text style={{ color: T.accent, fontWeight: "600" }}>{emptyState.text}</Text></>
                    : <>{t.empty_prompt}{" "}<Text style={{ color: T.accent, fontWeight: "600" }}>{currentEmptyLabel}</Text>{" "}{t.empty_prompt2}</>
                  }
                </Text>
              </View>
            ) : (
              <ResultCard motoKey={result.key} data={{ [result.key]: result.data }} searchMode={mode} t={t} isWide={isWide} />
            )}
          </ScrollView>

          {/* ─── NAV BAR — responsive ──────────────────────────────── */}
          {/* Sur mobile : icône + label en colonne ; sur wide : icône + label en ligne */}
          <View style={[styles.nav, isWide && { paddingVertical: 10 }]}>
            {navItems.map((n) => (
              <TouchableOpacity
                key={n.id}
                style={[
                  styles.navItem,
                  isWide && { flexDirection: "row", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10,
                    backgroundColor: activeNav === n.id ? "rgba(249,115,22,0.12)" : "transparent" },
                ]}
                onPress={() => {
                  setActiveNav(n.id);
                  if (n.id === "upload") { if (!canUpload) { Alert.alert(t.access_denied, t.access_denied_msg); return; } setShowUpload(true); }
                  if (n.id === "stats")  setShowStats(true);
                  if (n.id === "params") setShowParams(true);
                  if (n.id === "admin")  setShowAdmin(true);
                }}
              >
                <Text style={{ fontSize: isWide ? 16 : 20 }}>{n.icon}</Text>
                <Text style={[
                  styles.navLabel,
                  activeNav === n.id && { color: T.accent },
                  isWide && { fontSize: 13, marginTop: 0 },
                ]}>
                  {n.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

        </SafeAreaView>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  appRoot:             { flex: 1, backgroundColor: T.bg },
  appInner:            { flex: 1 },
  safe:                { flex: 1, backgroundColor: T.bg },
  loginSafe:           { flex: 1, backgroundColor: T.bg },
  loginScroll:         { flexGrow: 1, padding: 0 },
  // FIX loginCard : pas de maxHeight fixe pour éviter le clipping sur petits écrans
  loginCard:           { shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 48, elevation: 24 },
  langRow:             { flexDirection: "row", alignSelf: "flex-end", marginBottom: 16 },
  langBtn:             { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: T.border, backgroundColor: T.surface2, marginLeft: 8 },
  langBtnActive:       { backgroundColor: T.accent, borderColor: T.accent },
  langBtnText:         { fontSize: 13, color: T.muted, fontWeight: "500" },
  langBtnTextActive:   { color: "#fff" },
  logoWrap:            { alignItems: "center", marginBottom: 28 },
  logoIcon:            { width: 72, height: 72, backgroundColor: T.accent, borderRadius: 22, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  logoText:            { fontSize: 26, fontWeight: "700", color: T.text, letterSpacing: 1 },
  logoTagline:         { fontSize: 13, color: T.muted, marginTop: 4 },
  fieldLabel:          { fontSize: 11, color: T.muted, fontWeight: "600", letterSpacing: 1, marginBottom: 6 },
  input:               { backgroundColor: T.surface2, borderWidth: 1.5, borderColor: T.border, borderRadius: 12, padding: 14, color: T.text, fontSize: 15 },
  loginBtn:            { backgroundColor: T.accent, borderRadius: 14, padding: 16, alignItems: "center", marginBottom: 12 },
  loginBtnText:        { color: "#fff", fontSize: 16, fontWeight: "600" },
  backBtn:             { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 4, marginBottom: 8 },
  backBtnText:         { color: T.accent, fontSize: 14, fontWeight: "600" },
  toast:               { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
  // ── Header
  header:              { backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.border, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  headerInner:         { width: "100%" },
  headerTop:           { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  headerLogo:          { flexDirection: "row", alignItems: "center" },
  headerIcon:          { width: 32, height: 32, backgroundColor: T.accent, borderRadius: 9, alignItems: "center", justifyContent: "center", marginRight: 8 },
  headerTitle:         { fontSize: 16, fontWeight: "700", color: T.text, letterSpacing: 1 },
  logoutBtn:           { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  logoutText:          { fontSize: 11, color: T.muted },
  // ── Tabs
  tabs:                { backgroundColor: T.surface2, borderRadius: 12, padding: 4 },
  tab:                 { paddingVertical: 8, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  tabWide:             { flex: 1 },
  tabActive:           { backgroundColor: T.accent },
  tabText:             { color: T.muted, fontSize: 12, fontWeight: "500" },
  tabTextActive:       { color: "#fff" },
  // ── Search
  searchRow:           { flexDirection: "row" },
  searchInput:         { flex: 1, backgroundColor: T.surface2, borderWidth: 1.5, borderColor: T.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, color: T.text, fontSize: 14, letterSpacing: 1, marginRight: 8 },
  searchBtn:           { width: 46, backgroundColor: T.accent, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  // ── Content
  content:             { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  contentContainer:    { paddingBottom: 24 },
  emptyState:          { alignItems: "center", justifyContent: "center", paddingTop: 80 },
  emptyIcon:           { fontSize: 48, opacity: 0.4, marginBottom: 12 },
  emptyText:           { color: T.muted, fontSize: 14, textAlign: "center", lineHeight: 22, maxWidth: 240 },
  // ── Result
  resultContainer:     { paddingBottom: 8 },
  resultRowWide:       { flexDirection: "row", alignItems: "flex-start" },
  matchPill:           { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(249,115,22,0.1)", borderWidth: 1, borderColor: "rgba(249,115,22,0.25)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, alignSelf: "flex-start", marginBottom: 12 },
  matchPillText:       { fontSize: 12, color: T.accent, fontWeight: "500" },
  motoBadge:           { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 16, padding: 16, flexDirection: "row", alignItems: "center", marginBottom: 12 },
  motoLabel:           { fontSize: 10, color: T.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  motoKey:             { fontSize: 24, fontWeight: "700", color: T.accent, letterSpacing: 2, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  // ── Cards / rows
  card:                { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 14, overflow: "hidden", marginBottom: 12 },
  sectionTitle:        { paddingHorizontal: 14, paddingVertical: 9, fontSize: 10, letterSpacing: 2, color: T.muted, fontWeight: "600", borderBottomWidth: 1, borderBottomColor: T.border },
  badge:               { flexDirection: "row", alignItems: "center", borderRadius: 20, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, alignSelf: "flex-start", marginBottom: 12 },
  badgeDot:            { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  badgeText:           { fontSize: 11, fontWeight: "600", letterSpacing: 1 },
  infoRow:             { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "rgba(37,42,56,0.6)" },
  infoLabel:           { fontSize: 12, color: T.muted, flexShrink: 0 },
  infoValue:           { fontSize: 13, color: T.text, fontWeight: "500", textAlign: "right", flex: 1, marginLeft: 12 },
  // ── Upload / modales
  modalHeader:         { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: T.border },
  uploadHeader:        { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  uploadTitle:         { fontSize: 18, fontWeight: "700", color: T.text },
  uploadCount:         { fontSize: 12, color: T.muted, marginTop: 3 },
  closeBtn:            { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  closeBtnText:        { color: T.muted, fontSize: 13 },
  dropZone:            { borderWidth: 2, borderStyle: "dashed", borderColor: T.border, borderRadius: 16, padding: 28, alignItems: "center", backgroundColor: T.surface2 },
  dropTitle:           { fontSize: 15, color: T.text, fontWeight: "600", marginBottom: 4 },
  dropSub:             { fontSize: 12, color: T.muted },
  formatPill:          { marginTop: 12, backgroundColor: "rgba(249,115,22,0.1)", borderWidth: 1, borderColor: "rgba(249,115,22,0.25)", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 4 },
  formatPillText:      { fontSize: 11, color: T.accent },
  exportBtn:           { backgroundColor: "rgba(59,130,246,0.1)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 12, padding: 14, alignItems: "center", marginBottom: 8 },
  exportBtnText:       { color: T.blue, fontSize: 14, fontWeight: "600" },
  codeBlock:           { fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace", fontSize: 10, color: T.muted, lineHeight: 20 },
  statusChip:          { borderWidth: 1, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  statusChipText:      { fontSize: 11, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  resetBtn:            { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 12, padding: 14, alignItems: "center", marginTop: 8 },
  resetBtnText:        { color: T.muted, fontSize: 13 },
  // ── Nav
  nav:                 { flexDirection: "row", backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border, paddingBottom: Platform.OS === "ios" ? 20 : 8, paddingTop: 8, justifyContent: "space-around" },
  navItem:             { flex: 1, alignItems: "center", paddingVertical: 4 },
  navLabel:            { fontSize: 10, color: T.muted, marginTop: 3 },
  // ── Page header
  pageHeader:          { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  pageHeaderIconWrap:  { width: 56, height: 56, backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 16, alignItems: "center", justifyContent: "center", marginRight: 14 },
  pageHeaderTitle:     { fontSize: 20, fontWeight: "700", color: T.text, marginBottom: 3 },
  pageHeaderSub:       { fontSize: 12, color: T.muted },
  pageHeaderDesc:      { fontSize: 13, color: T.muted, lineHeight: 20, marginBottom: 8 },
  divider:             { height: 1, backgroundColor: T.border, marginVertical: 16 },
  // ── KPI / stats
  kpiCard:             { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 20 },
  kpiNumber:           { fontSize: 48, fontWeight: "700", color: T.accent, lineHeight: 56 },
  kpiLabel:            { fontSize: 13, color: T.muted, marginTop: 4 },
  statRow:             { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(37,42,56,0.6)", gap: 12 },
  statDot:             { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  statRank:            { fontSize: 11, fontWeight: "700", width: 22, flexShrink: 0 },
  statLabel:           { fontSize: 12, color: T.text, fontWeight: "500" },
  statCount:           { fontSize: 12, color: T.muted },
  soonChip:            { backgroundColor: "rgba(234,179,8,0.12)", borderWidth: 1, borderColor: "rgba(234,179,8,0.3)", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, marginLeft: 8, flexShrink: 0 },
  soonChipText:        { fontSize: 10, color: T.yellow, fontWeight: "600" },
  // ── Settings
  settingsRow:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(37,42,56,0.6)" },
  settingsRowLeft:     { flexDirection: "row", alignItems: "center", flex: 1 },
  settingsIconWrap:    { width: 36, height: 36, backgroundColor: T.bg, borderRadius: 10, borderWidth: 1, borderColor: T.border, alignItems: "center", justifyContent: "center", marginRight: 12 },
  settingsLabel:       { fontSize: 13, fontWeight: "600", color: T.text, marginBottom: 2 },
  settingsSub:         { fontSize: 11, color: T.muted },
  // ── Lang picker
  langChoiceBtn:       { flexDirection: "row", alignItems: "center", backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border, borderRadius: 14, padding: 16, marginTop: 12 },
  langChoiceBtnActive: { borderColor: T.accent, backgroundColor: "rgba(249,115,22,0.06)" },
  langChoiceLabel:     { fontSize: 16, fontWeight: "600", color: T.text },
  langChoiceSub:       { fontSize: 11, color: T.muted, marginTop: 2 },
  langCheckBadge:      { width: 24, height: 24, borderRadius: 12, backgroundColor: T.accent, alignItems: "center", justifyContent: "center" },
  // ── Admin
  admAgentRow:         { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(37,42,56,0.6)" },
  admAgentId:          { fontSize: 13, fontWeight: "700", color: T.text, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  admActionBtn:        { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  admRoleBadge:        { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  // ── Auto-logout grid
  alGrid:              { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  alOptionBtn:         { borderWidth: 1.5, borderColor: T.border, borderRadius: 12, paddingVertical: 14, alignItems: "center", justifyContent: "center", width: "17%", marginRight: "3%", marginBottom: 12, backgroundColor: T.surface2 },
  alOptionNum:         { fontSize: 18, fontWeight: "700", color: T.muted },
  alOptionUnit:        { fontSize: 9, color: T.muted, marginTop: 2 },
});

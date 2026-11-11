/**
 * flux_export.js — Paso 1 soberanía (Spark): exportar tenant a ZIP.
 * Datos Firestore + Storage + front Admin/Cobrador (sin SuperAdmin).
 */
(function (global) {
    'use strict';

    /** Colecciones con filtro EmpresaId. Empresas y Config se exportan aparte. */
    const COLECCIONES_EXPORT_ENTREGA = [
        'Equipo',
        'Clientes',
        'Movimientos',
        'Documentos',
        'DiasFestivos'
    ];

    /** Archivos de front para el cliente (Admin + Cobrador). Sin panel SuperAdmin. */
    const FRONT_ARCHIVOS_ENTREGA = [
        'index.html',
        'admin.html',
        'logic_Manager.js',
        'database_manager.js',
        'pwa.js',
        'sw.js',
        'manifest-admin.json',
        'manifest-cobrador.json',
        'firebase.json',
        'logo.jpg',
        'i18n/es/admin.js',
        'i18n/en/admin.js',
        'i18n/pt/admin.js',
        'i18n/es/cobrador.js',
        'i18n/en/cobrador.js',
        'i18n/pt/cobrador.js',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/apple-touch-icon.png'
    ];

    function esUsuarioExcluidoExport(data, normalizarCargoFn) {
        const d = data || {};
        const cargo = typeof normalizarCargoFn === 'function'
            ? normalizarCargoFn(d)
            : String(d.Cargo || d.cargo || '');
        if (cargo === 'SuperAdmin') return true;
        const modo = String(d.Modo || d.modo || '').trim().toLowerCase();
        return modo === 'plataforma';
    }

    function serializarFirestoreValor(v) {
        if (v == null) return v;
        if (typeof v === 'object' && typeof v.toDate === 'function') {
            try { return v.toDate().toISOString(); } catch (_) { return String(v); }
        }
        if (Array.isArray(v)) return v.map(serializarFirestoreValor);
        if (typeof v === 'object') {
            const out = {};
            Object.keys(v).forEach((k) => {
                out[k] = serializarFirestoreValor(v[k]);
            });
            return out;
        }
        return v;
    }

    function docExportPayload(doc) {
        return {
            id: doc.id,
            data: serializarFirestoreValor(doc.data() || {})
        };
    }

    async function listarStorageRecursivo(storage, path) {
        if (!path || !storage) return [];
        const out = [];
        try {
            const list = await storage.ref(path).listAll();
            for (const item of list.items) {
                out.push({
                    path: item.fullPath,
                    name: item.name,
                    url: await item.getDownloadURL()
                });
            }
            for (const pref of list.prefixes) {
                const sub = await listarStorageRecursivo(storage, pref.fullPath);
                out.push(...sub);
            }
        } catch (_) { /* carpeta vacía o sin permiso */ }
        return out;
    }

    function urlsHttpDeObjeto(obj, acc) {
        const bag = acc || [];
        if (!obj) return bag;
        if (typeof obj === 'string') {
            if (/^https?:\/\//i.test(obj)) bag.push(obj);
            return bag;
        }
        if (Array.isArray(obj)) {
            obj.forEach((x) => urlsHttpDeObjeto(x, bag));
            return bag;
        }
        if (typeof obj === 'object') {
            Object.keys(obj).forEach((k) => urlsHttpDeObjeto(obj[k], bag));
        }
        return bag;
    }

    function extensionDesdeUrlONombre(url, nombre) {
        const base = String(nombre || url || '').split('?')[0];
        const m = base.match(/\.(jpe?g|png|webp|gif|pdf|bin)$/i);
        return m ? ('.' + m[1].toLowerCase().replace('jpeg', 'jpg')) : '.bin';
    }

    async function fetchBlobDesdeUrl(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('http_' + res.status);
        return res.blob();
    }

    function descargarBlobLocal(blob, filename) {
        const a = document.createElement('a');
        const href = URL.createObjectURL(blob);
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 2500);
    }

    /** Quita del HTML la vista/menú/modales exclusivos de SuperAdmin. */
    function stripSuperAdminDelAdminHtml(html) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            doc.querySelectorAll('[data-solo-superadmin]').forEach((el) => el.remove());
            const panel = doc.getElementById('panel-super-admin');
            if (panel) panel.remove();
            const modalExport = doc.getElementById('modal-export-entrega');
            if (modalExport) modalExport.remove();
            const mark = doc.createComment(' Flux entrega: UI SuperAdmin excluida ');
            if (doc.body) doc.body.insertBefore(mark, doc.body.firstChild);
            return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        } catch (e) {
            console.warn('stripSuperAdminDelAdminHtml', e);
            return html;
        }
    }

    async function fetchFrontArchivoEntrega(relPath, baseHref) {
        const url = new URL(relPath, baseHref || (typeof window !== 'undefined' ? window.location.href : '')).toString();
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(), {
            cache: 'no-store'
        });
        if (!res.ok) throw new Error('front_http_' + res.status + '_' + relPath);
        if (relPath.endsWith('.html') || relPath.endsWith('.js') || relPath.endsWith('.json') || relPath.endsWith('.txt')) {
            let text = await res.text();
            if (relPath === 'admin.html' || relPath.endsWith('/admin.html')) {
                text = stripSuperAdminDelAdminHtml(text);
            }
            return { path: 'front/' + relPath, content: text, binary: false };
        }
        const buf = await res.arrayBuffer();
        return { path: 'front/' + relPath, content: buf, binary: true };
    }

    async function recolectarFrontEntregaCliente(onProgress, baseHref, listaFront) {
        const archivos = Array.isArray(listaFront) && listaFront.length
            ? listaFront
            : FRONT_ARCHIVOS_ENTREGA;
        const incluidos = [];
        const omitidos = [];
        for (let i = 0; i < archivos.length; i++) {
            const rel = archivos[i];
            if (typeof onProgress === 'function') onProgress(i + 1, archivos.length, rel);
            try {
                incluidos.push(await fetchFrontArchivoEntrega(rel, baseHref));
            } catch (e) {
                console.warn('Front omitido', rel, e);
                omitidos.push(rel);
            }
        }
        incluidos.push({
            path: 'front/config.example.js',
            content: [
                '/**',
                ' * Copie como config.js y pegue las claves del Firebase DESTINO del cliente.',
                ' * Consola Firebase → Configuración del proyecto → Tus apps.',
                ' */',
                'window.FLUX_FIREBASE_CONFIG = {',
                '    apiKey: "PEGAR_API_KEY",',
                '    authDomain: "PEGAR_PROJECT_ID.firebaseapp.com",',
                '    projectId: "PEGAR_PROJECT_ID",',
                '    storageBucket: "PEGAR_PROJECT_ID.firebasestorage.app",',
                '    messagingSenderId: "PEGAR_MESSAGING_SENDER_ID",',
                '    appId: "PEGAR_APP_ID"',
                '};',
                ''
            ].join('\n'),
            binary: false
        });
        incluidos.push({
            path: 'front/LEER-FRONT.txt',
            content: [
                'FRONT del cliente (Admin + Cobrador)',
                '',
                'Incluye la app para que otra persona administre en el nuevo hosting.',
                'NO incluye la UI de SuperAdmin (panel de plataforma / empresas).',
                '',
                '1. Pegue claves en config.js (vea config.example.js).',
                '2. Despliegue la carpeta front/ en Firebase Hosting del cliente.',
                '3. Importe firestore/ + storage/ (Paso 2).',
                ''
            ].join('\n'),
            binary: false
        });
        return { incluidos, omitidos };
    }

    function normalizarMonedaExport(codigo, normalizarMonedaFn) {
        const raw = String(codigo || '').trim();
        if (!raw) return '';
        if (typeof normalizarMonedaFn === 'function') return normalizarMonedaFn(raw);
        if (raw.toLowerCase() === 'ecuador') return 'USD';
        return raw.toUpperCase();
    }

    /**
     * Construye el ZIP de entrega (Paso 1).
     * @param {object} opts
     * @param {object} opts.db Firestore
     * @param {object} opts.storage Firebase Storage
     * @param {function} opts.JSZip constructor JSZip
     * @param {string} opts.empresaId
     * @param {string} [opts.nombreEmpresa]
     * @param {string} [opts.empresaLegacy='flux_default']
     * @param {function} [opts.normalizarCargo]
     * @param {function} [opts.normalizarMoneda]
     * @param {function} [opts.onProgress] (texto) => void
     * @param {function} [opts.onFrontProgress] (n, total, rel) => void
     * @param {string} [opts.baseHref]
     * @param {string[]} [opts.frontArchivos]
     * @returns {Promise<{blob:Blob, filename:string, checklist:object, excluidosEquipo:string[], storageFail:number, frontOmitidos:string[]}>}
     */
    async function construirZipEntrega(opts) {
        const o = opts || {};
        const db = o.db;
        const storage = o.storage;
        const JSZipCtor = o.JSZip;
        const eid = String(o.empresaId || '').trim();
        const empresaLegacy = o.empresaLegacy || 'flux_default';
        const nombre = String(o.nombreEmpresa || eid).trim();
        const progress = typeof o.onProgress === 'function' ? o.onProgress : function () {};

        if (!db) throw new Error('export_sin_db');
        if (!JSZipCtor) throw new Error('export_sin_jszip');
        if (!eid || eid === empresaLegacy || eid === 'app') throw new Error('export_protegido');

        progress('leyendo_fs');
        const empSnap = await db.collection('Empresas').doc(eid).get();
        if (!empSnap.exists) throw new Error('export_sin_empresa');

        const porColeccion = {};
        const excluidosEquipo = [];
        for (const col of COLECCIONES_EXPORT_ENTREGA) {
            const snap = await db.collection(col).where('EmpresaId', '==', eid).get();
            const docs = [];
            snap.forEach((doc) => {
                const d = doc.data() || {};
                if (col === 'Equipo' && esUsuarioExcluidoExport(d, o.normalizarCargo)) {
                    excluidosEquipo.push(doc.id);
                    return;
                }
                docs.push(docExportPayload(doc));
            });
            porColeccion[col] = docs;
        }

        const cfgSnap = await db.collection('Config').doc(eid).get();
        const configDoc = cfgSnap.exists ? docExportPayload(cfgSnap) : null;

        let empresaData = serializarFirestoreValor(empSnap.data() || {});
        let monedaTenant = String(empresaData.Moneda || empresaData.moneda || '').trim();
        if (!monedaTenant) {
            const adminEq = (porColeccion.Equipo || []).find((item) => {
                const cargo = String((item.data || {}).Cargo || '').toLowerCase();
                return cargo === 'admin';
            });
            monedaTenant = String(
                (adminEq && adminEq.data && (adminEq.data.Moneda || adminEq.data.moneda)) || ''
            ).trim();
        }
        monedaTenant = normalizarMonedaExport(monedaTenant, o.normalizarMoneda);
        empresaData = {
            ...empresaData,
            EmpresaId: eid,
            Pausada: false,
            Estado: 'Activo'
        };
        if (monedaTenant) empresaData.Moneda = monedaTenant;
        delete empresaData.DemoCredenciales;

        if (configDoc && configDoc.data) {
            const cfgMon = String(configDoc.data.Moneda || configDoc.data.moneda || '').trim();
            if (!cfgMon && monedaTenant) configDoc.data.Moneda = monedaTenant;
        }

        progress('leyendo_storage');
        const clienteIds = (porColeccion.Clientes || []).map((c) => c.id);
        const archivosStorage = [];
        const logoFiles = await listarStorageRecursivo(storage, 'clientes/_logo_' + eid);
        archivosStorage.push(...logoFiles);
        const logoLegacy = await listarStorageRecursivo(storage, 'config/' + eid);
        archivosStorage.push(...logoLegacy);
        for (const cid of clienteIds) {
            const fotos = await listarStorageRecursivo(storage, 'clientes/' + cid);
            archivosStorage.push(...fotos);
        }

        const urlsExtra = new Set();
        (porColeccion.Movimientos || []).forEach((m) => {
            urlsHttpDeObjeto(m.data, []).forEach((u) => urlsExtra.add(u));
        });
        (porColeccion.Clientes || []).forEach((c) => {
            urlsHttpDeObjeto(c.data, []).forEach((u) => urlsExtra.add(u));
        });
        const urlsYaEnStorage = new Set(archivosStorage.map((a) => a.url));
        const urlsHuérfanas = [...urlsExtra].filter((u) => u && !urlsYaEnStorage.has(u));

        progress('leyendo_front');
        const frontPack = await recolectarFrontEntregaCliente(
            o.onFrontProgress,
            o.baseHref,
            o.frontArchivos
        );

        const zip = new JSZipCtor();
        const checklist = {
            empresaId: eid,
            nombreEmpresa: nombre,
            generadoEn: new Date().toISOString(),
            plan: 'spark',
            paso: 1,
            incluyeFrontAdmin: true,
            incluyeFrontCobrador: true,
            incluyeFrontSuperAdmin: false,
            frontCarpeta: 'front/',
            forzadoActivo: true,
            superAdminExcluidosEquipo: excluidosEquipo.length,
            frontOmitidos: frontPack.omitidos,
            conteos: {
                Empresas: 1,
                Config: configDoc ? 1 : 0,
                Equipo: (porColeccion.Equipo || []).length,
                Clientes: (porColeccion.Clientes || []).length,
                Movimientos: (porColeccion.Movimientos || []).length,
                Documentos: (porColeccion.Documentos || []).length,
                DiasFestivos: (porColeccion.DiasFestivos || []).length,
                FrontArchivos: frontPack.incluidos.length,
                StorageArchivos: 0,
                StorageUrlsExtra: 0
            },
            avisos: [
                'Incluye front Admin + Cobrador para administrar en el hosting del cliente.',
                'UI SuperAdmin (panel plataforma) excluida del front.',
                'Datos SuperAdmin / Modo plataforma no se exportan.',
                'En destino: Pausada=false y Estado=Activo.',
                'Paso 2: importar firestore/ + storage/ y desplegar front/ en el Firebase del cliente.'
            ]
        };

        zip.file('firestore/Empresas/' + eid + '.json', JSON.stringify({
            id: eid,
            data: empresaData
        }, null, 2));

        if (configDoc) {
            zip.file('firestore/Config/' + configDoc.id + '.json', JSON.stringify(configDoc, null, 2));
        }

        for (const col of COLECCIONES_EXPORT_ENTREGA) {
            for (const item of (porColeccion[col] || [])) {
                zip.file('firestore/' + col + '/' + item.id + '.json', JSON.stringify(item, null, 2));
            }
        }

        let storageOk = 0;
        let storageFail = 0;
        for (let i = 0; i < archivosStorage.length; i++) {
            const f = archivosStorage[i];
            progress('archivo_storage:' + (i + 1) + '/' + (archivosStorage.length + urlsHuérfanas.length));
            try {
                const blob = await fetchBlobDesdeUrl(f.url);
                zip.file('storage/' + f.path, blob);
                storageOk++;
            } catch (e) {
                storageFail++;
                console.warn('Export storage fail', f.path, e);
            }
        }

        const urlMap = [];
        for (let i = 0; i < urlsHuérfanas.length; i++) {
            const url = urlsHuérfanas[i];
            progress('archivo_url:' + (archivosStorage.length + i + 1) + '/' + (archivosStorage.length + urlsHuérfanas.length));
            try {
                const blob = await fetchBlobDesdeUrl(url);
                const ext = extensionDesdeUrlONombre(url);
                const nombreArchivo = 'url_' + (i + 1) + '_' + Date.now().toString(36) + ext;
                const rel = 'storage/_urls/' + nombreArchivo;
                zip.file(rel, blob);
                urlMap.push({ url, path: rel });
                storageOk++;
            } catch (e) {
                storageFail++;
                urlMap.push({ url, path: null, error: String(e && e.message || e) });
            }
        }

        checklist.conteos.StorageArchivos = storageOk;
        checklist.conteos.StorageUrlsExtra = urlMap.filter((x) => x.path).length;
        checklist.storageFallidos = storageFail;
        if (urlMap.length) {
            zip.file('storage/_urls/map.json', JSON.stringify(urlMap, null, 2));
        }

        for (const f of frontPack.incluidos) {
            zip.file(f.path, f.content);
        }

        zip.file('manifest.json', JSON.stringify(checklist, null, 2));
        zip.file('FRONT.txt', [
            'FRONT — Admin + Cobrador (sin SuperAdmin)',
            '',
            'Carpeta: front/',
            'Incluye admin.html (sin panel SuperAdmin), index.html (cobrador),',
            'logic_Manager.js, i18n, PWA, iconos y config.example.js.',
            '',
            'NO incluye UI ni datos de SuperAdmin (plataforma).',
            'Otra persona administrará con el Admin de la empresa en el nuevo hosting.',
            '',
            'incluyeFrontAdmin: true',
            'incluyeFrontCobrador: true',
            'incluyeFrontSuperAdmin: false',
            'frontOmitidos: ' + (frontPack.omitidos.join(', ') || '(ninguno)')
        ].join('\n'));
        zip.file('CHECKLIST.txt', [
            'CHECKLIST entrega — ' + nombre,
            'EmpresaId: ' + eid,
            'Generado: ' + checklist.generadoEn,
            '',
            Object.keys(checklist.conteos).map((k) => '• ' + k + ': ' + checklist.conteos[k]).join('\n'),
            '',
            'SuperAdmin excluidos de Equipo: ' + excluidosEquipo.length,
            'Storage fallidos: ' + storageFail,
            'Front omitidos: ' + (frontPack.omitidos.join(', ') || '(ninguno)'),
            '',
            checklist.avisos.map((a) => '- ' + a).join('\n')
        ].join('\n'));

        progress('empaquetando');
        const blobZip = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const fname = 'flux-entrega-' + eid + '-' + new Date().toISOString().slice(0, 10) + '.zip';

        return {
            blob: blobZip,
            filename: fname,
            checklist,
            excluidosEquipo,
            storageFail,
            frontOmitidos: frontPack.omitidos
        };
    }

    const FluxExport = {
        COLECCIONES_EXPORT_ENTREGA,
        FRONT_ARCHIVOS_ENTREGA,
        esUsuarioExcluidoExport,
        serializarFirestoreValor,
        docExportPayload,
        listarStorageRecursivo,
        urlsHttpDeObjeto,
        extensionDesdeUrlONombre,
        fetchBlobDesdeUrl,
        descargarBlobLocal,
        stripSuperAdminDelAdminHtml,
        fetchFrontArchivoEntrega,
        recolectarFrontEntregaCliente,
        construirZipEntrega
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FluxExport;
    }
    global.FluxExport = FluxExport;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);

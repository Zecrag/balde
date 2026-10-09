document.addEventListener('DOMContentLoaded', () => {
  const steps = [
    document.getElementById('step-1'),
    document.getElementById('step-2'),
    document.getElementById('step-3'),
    document.getElementById('step-4')
  ];
  const stepIndicator = document.getElementById('step-indicator');
  
  let currentStep = 1;

  // GB-47: link do convite (http://127.0.0.1:7391/setup#convite=CODIGO) já preenche o código.
  const conviteDoLink = (location.hash.match(/convite=([A-Za-z0-9_-]+)/) || [])[1] || '';

  function showStep(n) {
    steps.forEach((el, i) => {
      if (i + 1 === n) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    });
    currentStep = n;
    stepIndicator.textContent = `Passo ${n} de 4`;
  }

  // --- Step 1: OpenAI ---
  const btnOpenai = document.getElementById('btn-openai');
  const inputOpenai = document.getElementById('openai-key');
  const errorOpenai = document.getElementById('error-openai');

  btnOpenai.addEventListener('click', async () => {
    const key = inputOpenai.value.trim();
    if (!key) {
      errorOpenai.textContent = 'Informe a chave da OpenAI';
      errorOpenai.classList.remove('hidden');
      return;
    }
    
    errorOpenai.classList.add('hidden');
    btnOpenai.disabled = true;
    btnOpenai.textContent = 'Validando...';

    try {
      const res = await fetch('/api/setup/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Falha ao validar chave');
      
      showStep(2);
      if (conviteDoLink) abrirConvite();
    } catch (err) {
      errorOpenai.textContent = err.message;
      errorOpenai.classList.remove('hidden');
    } finally {
      btnOpenai.disabled = false;
      btnOpenai.textContent = 'Validar e Continuar';
    }
  });

  // --- Step 2: WhatsApp Connection ---
  const btnOptBaileys = document.getElementById('btn-opt-baileys');
  const btnOptEvolution = document.getElementById('btn-opt-evolution');
  const evolutionForm = document.getElementById('evolution-form');
  const qrContainer = document.getElementById('qr-container');
  const btnEvolution = document.getElementById('btn-evolution');
  const errorEvolution = document.getElementById('error-evolution');

  const btnOptConvite = document.getElementById('btn-opt-convite');
  const conviteForm = document.getElementById('convite-form');
  const conviteCodigo = document.getElementById('convite-codigo');
  const btnConvite = document.getElementById('btn-convite');
  const errorConvite = document.getElementById('error-convite');
  const qrAjuda = document.getElementById('qr-ajuda');
  // De onde vem o QR: Baileys local ou a instância do convite na Evolution.
  let qrRota = '/api/setup/qr';

  function pararQr() {
    if (qrInterval) clearInterval(qrInterval);
    qrInterval = null;
  }

  function abrirConvite() {
    pararQr();
    conviteForm.classList.remove('hidden');
    evolutionForm.classList.add('hidden');
    qrContainer.classList.add('hidden');
    if (conviteDoLink && !conviteCodigo.value) conviteCodigo.value = conviteDoLink;
    conviteCodigo.focus();
  }

  btnOptConvite.addEventListener('click', abrirConvite);

  btnConvite.addEventListener('click', async () => {
    const codigo = conviteCodigo.value.trim();
    if (!codigo) {
      errorConvite.textContent = 'Cole o código de convite';
      errorConvite.classList.remove('hidden');
      return;
    }
    errorConvite.classList.add('hidden');
    btnConvite.disabled = true;
    btnConvite.textContent = 'Conferindo...';
    try {
      const res = await fetch('/api/setup/convite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Convite recusado');

      conviteForm.classList.add('hidden');
      qrContainer.classList.remove('hidden');
      errorQr.classList.add('hidden');
      qrImage.classList.add('hidden');
      qrStatus.textContent = 'Gerando o QR code...';
      qrRota = '/api/setup/convite/qr';
      pararQr();
      qrInterval = setInterval(checkQr, 2000);
      checkQr();
    } catch (err) {
      errorConvite.textContent = err.message;
      errorConvite.classList.remove('hidden');
    } finally {
      btnConvite.disabled = false;
      btnConvite.textContent = 'Usar convite';
    }
  });

  btnOptEvolution.addEventListener('click', () => {
    pararQr();
    evolutionForm.classList.remove('hidden');
    conviteForm.classList.add('hidden');
    qrContainer.classList.add('hidden');
  });

  btnEvolution.addEventListener('click', async () => {
    const url = document.getElementById('evo-url').value.trim();
    const apikey = document.getElementById('evo-key').value.trim();
    const instance = document.getElementById('evo-inst').value.trim();

    if (!url || !apikey || !instance) {
      errorEvolution.textContent = 'Preencha todos os campos';
      errorEvolution.classList.remove('hidden');
      return;
    }

    errorEvolution.classList.add('hidden');
    btnEvolution.disabled = true;
    btnEvolution.textContent = 'Testando...';

    try {
      const res = await fetch('/api/setup/evolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apikey, instance })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Falha ao conectar');
      
      showStep(3);
      loadGrupos();
    } catch (err) {
      errorEvolution.textContent = err.message;
      errorEvolution.classList.remove('hidden');
    } finally {
      btnEvolution.disabled = false;
      btnEvolution.textContent = 'Testar e Salvar';
    }
  });

  let qrInterval = null;
  const qrImage = document.getElementById('qr-image');
  const qrStatus = document.getElementById('qr-status');
  const errorQr = document.getElementById('error-qr');

  btnOptBaileys.addEventListener('click', async () => {
    pararQr();
    qrRota = '/api/setup/qr';
    evolutionForm.classList.add('hidden');
    conviteForm.classList.add('hidden');
    qrContainer.classList.remove('hidden');
    errorQr.classList.add('hidden');
    qrStatus.textContent = 'Iniciando WhatsApp...';
    qrImage.classList.add('hidden');

    try {
      const res = await fetch('/api/setup/baileys/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Falha ao iniciar Baileys');
      
      if (qrInterval) clearInterval(qrInterval);
      qrInterval = setInterval(checkQr, 2000);
      checkQr();
    } catch (err) {
      errorQr.textContent = err.message;
      errorQr.classList.remove('hidden');
    }
  });

  async function checkQr() {
    try {
      const res = await fetch(qrRota);
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Erro ao checar QR');

      if (data.status === 'connected') {
        pararQr();
        qrStatus.textContent = 'Conectado!';
        qrImage.classList.add('hidden');
        qrAjuda.classList.add('hidden');
        setTimeout(() => {
          showStep(3);
          loadGrupos();
        }, 1500);
      } else if (data.qr) {
        qrStatus.textContent = 'Leia o QR code com seu WhatsApp';
        qrImage.src = data.qr;
        qrImage.classList.remove('hidden');
        qrAjuda.classList.remove('hidden');
        errorQr.classList.add('hidden');
      }
    } catch (err) {
      errorQr.textContent = err.message;
      errorQr.classList.remove('hidden');
    }
  }

  // --- Step 3: Grupos ---
  const gruposLoading = document.getElementById('grupos-loading');
  const gruposList = document.getElementById('grupos-list');
  const errorGrupos = document.getElementById('error-grupos');
  const btnGrupos = document.getElementById('btn-grupos');
  
  let loadedGrupos = [];

  async function loadGrupos() {
    gruposLoading.classList.remove('hidden');
    gruposList.classList.add('hidden');
    btnGrupos.classList.add('hidden');
    errorGrupos.classList.add('hidden');

    try {
      const res = await fetch('/api/setup/grupos');
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Erro ao carregar grupos');
      
      loadedGrupos = data.grupos || [];
      renderGrupos();
    } catch (err) {
      errorGrupos.textContent = err.message;
      errorGrupos.classList.remove('hidden');
      gruposLoading.classList.add('hidden');
    }
  }

  function renderGrupos() {
    gruposLoading.classList.add('hidden');
    gruposList.innerHTML = '';
    
    if (loadedGrupos.length === 0) {
      gruposList.innerHTML = '<p>Nenhum grupo encontrado.</p>';
      gruposList.classList.remove('hidden');
      btnGrupos.classList.remove('hidden');
      return;
    }

    loadedGrupos.forEach((g, index) => {
      const card = document.createElement('div');
      card.className = 'grupo-card';
      
      // Auto-fill heuristic based on group name
      const defaultName = g.nome || g.subject || '';
      const parts = defaultName.split(/[-|]/).map(s => s.trim()).filter(Boolean);
      const defaultEmpresa = parts[0] || defaultName;
      const defaultProjeto = parts.length > 1 ? parts.slice(1).join(' ') : 'Geral';

      card.innerHTML = `
        <div class="grupo-header">
          <input type="checkbox" id="chk-${index}" data-index="${index}">
          <label class="grupo-title" for="chk-${index}">${defaultName || 'Grupo sem nome'}</label>
        </div>
        <div class="grupo-fields hidden" id="fields-${index}">
          <input type="text" id="emp-${index}" placeholder="Empresa" value="${defaultEmpresa}">
          <input type="text" id="proj-${index}" placeholder="Projeto" value="${defaultProjeto}">
          <select id="tipo-${index}">
            <option value="cliente" selected>Cliente</option>
            <option value="despejo">Despejo</option>
          </select>
        </div>
      `;
      gruposList.appendChild(card);

      const chk = card.querySelector(`#chk-${index}`);
      const fields = card.querySelector(`#fields-${index}`);
      chk.addEventListener('change', () => {
        if (chk.checked) fields.classList.remove('hidden');
        else fields.classList.add('hidden');
      });
    });

    gruposList.classList.remove('hidden');
    btnGrupos.classList.remove('hidden');
  }

  btnGrupos.addEventListener('click', async () => {
    const selecionados = [];
    loadedGrupos.forEach((g, index) => {
      const chk = document.getElementById(`chk-${index}`);
      if (chk && chk.checked) {
        selecionados.push({
          id: g.jid || g.id,
          nome: g.nome || g.subject,
          empresa: document.getElementById(`emp-${index}`).value.trim(),
          projeto: document.getElementById(`proj-${index}`).value.trim(),
          tipo: document.getElementById(`tipo-${index}`).value
        });
      }
    });

    btnGrupos.disabled = true;
    btnGrupos.textContent = 'Salvando...';
    errorGrupos.classList.add('hidden');

    try {
      const res = await fetch('/api/setup/grupos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupos: selecionados })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || 'Falha ao salvar grupos');
      
      showStep(4);
    } catch (err) {
      errorGrupos.textContent = err.message;
      errorGrupos.classList.remove('hidden');
    } finally {
      btnGrupos.disabled = false;
      btnGrupos.textContent = 'Salvar Selecionados';
    }
  });

});

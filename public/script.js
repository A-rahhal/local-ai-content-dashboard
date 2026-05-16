const $ = (id) => document.getElementById(id);

  let lastPosts = [];

  function showToast(msg, type="ok"){
    const t = $("toast");
    t.textContent = msg;
    t.style.borderColor = type==="err" ? "rgba(255,77,109,.55)" : "rgba(255,255,255,.15)";
    t.classList.add("show");
    setTimeout(()=> t.classList.remove("show"), 2200);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function setLoading(on){
    const btn = $("gen");
    btn.disabled = on;
    $("genIcon").textContent = on ? "" : "⚡";
    $("genText").textContent = on ? "In progress..." : "content generation";
    if(on){
      $("genIcon").innerHTML = `<span class="spinner"></span>`;
    }
  }

  function updateStats(meta){
    $("statCount").innerHTML = `${lastPosts.length} <small>posts</small>`;
    $("statKind").textContent = meta?.postKind || "—";
    $("statLang").textContent = meta?.lang || "—";
    $("statLines").textContent = meta?.lines ?? "—";
  }

  function render(posts, meta){
    lastPosts = posts || [];
    $("json").textContent = JSON.stringify(lastPosts, null, 2);

    $("cards").innerHTML = lastPosts.map(p => {
        const img = p.imageBase64
          ? `<img src="data:image/png;base64,${p.imageBase64}" style="width:100%;border-radius:14px;margin:8px 0;border:1px solid rgba(255,255,255,.12)" />`
          : "";
      
        return `
          <div class="card">
            <div class="meta">
              <span class="badge">#${escapeHtml(p.id)}</span>
              <span>${escapeHtml(p.type || "")}</span>
            </div>
      
            ${img}
      
            <div class="text">${escapeHtml(p.text || "")}</div>
            <div class="tags">
              ${(p.hashtags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
        `;
      }).join("");
      

    updateStats(meta);
  }

  function payloadFromUI(){
    const endQ = $("endQuestion").value;
  
    return {
      postKind: $("postKind").value,
      lang: $("lang").value,
      lines: Number($("lines").value || 1),
      count: Number($("count").value || 10),
      category: $("category").value || "General",
      tone: $("tone").value,
      allowEmojis: $("emojis").value === "yes",
    
      examples: $("examples")?.value?.trim() || "",
      description: $("description")?.value?.trim() || "",
    
      // 🆕 random topics
      randomTopics: $("randomTopics")?.value === "yes",
      randomTopicsCount: Number($("randomTopicsCount")?.value || 10),
      topicsPool: $("topicsPool")?.value?.trim() || "",
    };
    
  }
  

  async function generate(){
    setLoading(true);
    $("status").textContent = "Generation is underway from the local model via backend...";
    try{
      const payload = payloadFromUI();
      const r = await fetch("http://127.0.0.1:3000/generate-posts", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload),
      });

      const data = await r.json();
      if(!r.ok) throw new Error(data?.details || data?.error || "Request failed");

      render(data.posts, data.meta);
      $("status").textContent = `finished${data.posts.length} Post ✅`;
      showToast("Generation completed successfully✅");
    }catch(e){
      $("status").textContent = "mistake: " + e.message;
      showToast("Obstetric failure❌", "err");
    }finally{
      setLoading(false);
    }
  }

  async function generateWithImages(){
    setLoading(true);
    $("status").textContent = "Generating in progress (text + images)...";
    try{
      const payload = payloadFromUI();
      // إعدادات SD اختيارية:
      payload.sd = { steps: 22, width: 512, height: 512 };
  
      const r = await fetch("/generate-posts-with-images", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload),
      });
  
      const data = await r.json();
      if(!r.ok) throw new Error(data?.details || data?.error || "Request failed");
  
      render(data.posts, data.meta);
      $("status").textContent = `finished${data.posts.length}Post and image ✅`;
      showToast("Generated with images✅");
    }catch(e){
      $("status").textContent = "mistake: " + e.message;
      showToast("Birth failure with pictures❌", "err");
    }finally{
      setLoading(false);
    }
  }
  

  async function health(){
    try{
      const r = await fetch("http://127.0.0.1:3000/health");
      const data = await r.json();
      showToast(data?.ok ? "Backend OK ✅" : "Backend not OK ❌", data?.ok ? "ok":"err");
    }catch{
      showToast("Backend Offline❌", "err");
    }
  }

  async function copyJSON(){
    try{
      await navigator.clipboard.writeText(JSON.stringify(lastPosts, null, 2));
      showToast("تم نسخ JSON ✅");
    }catch{
      showToast("فشل النسخ ❌", "err");
    }
  }

  function clearAll(){
    lastPosts = [];
    $("cards").innerHTML = "";
    $("json").textContent = "";
    updateStats({});
    $("status").textContent = "The results have been cleared.";
    showToast("Scanned✅");
  }

  // Quick topics chips
  $("quickTopics").addEventListener("click", (e)=>{
    const chip = e.target.closest(".chip");
    if(!chip) return;
    document.querySelectorAll(".chip").forEach(c=>c.classList.remove("active"));
    chip.classList.add("active");
    $("category").value = chip.dataset.topic || $("category").value;
  });

  // Theme toggle
  $("themeBtn").addEventListener("click", ()=>{
    const body = document.body;
    const next = body.getAttribute("data-theme")==="dark" ? "light" : "dark";
    body.setAttribute("data-theme", next);
    showToast(next==="dark" ? "Dark mode 🌙" : "Light mode ☀️");
  });

  // document.addEventListener("DOMContentLoaded", () => {
  //   const bind = (id, event, fn) => {
  //     const el = document.getElementById(id);
  //     if (!el) {
  //       console.warn(`Missing element: #${id}`);
  //       return;
  //     }
  //     el.addEventListener(event, fn);
  //   };
  
  //   bind("gen", "click", generate);
  //   bind("copy", "click", copyJSON);
  //   bind("clear", "click", clearAll);
  //   bind("healthBtn", "click", health);
  //   bind("genImg", "click", generateWithImages);
  
  //   // Quick topics chips
  //   const quickTopics = document.getElementById("quickTopics");
  //   if (quickTopics) {
  //     quickTopics.addEventListener("click", (e) => {
  //       const chip = e.target.closest(".chip");
  //       if (!chip) return;
  //       document.querySelectorAll(".chip").forEach(c=>c.classList.remove("active"));
  //       chip.classList.add("active");
  //       document.getElementById("category").value = chip.dataset.topic || document.getElementById("category").value;
  //     });
  //   }
  
  //   // Theme toggle
  //   bind("themeBtn", "click", () => {
  //     const body = document.body;
  //     const next = body.getAttribute("data-theme")==="dark" ? "light" : "dark";
  //     body.setAttribute("data-theme", next);
  //     showToast(next==="dark" ? "Dark mode 🌙" : "Light mode ☀️");
  //   });
  
  //   // First render
  //   render([], {});
  // });
  

  $("gen").addEventListener("click", generate);
  // $("copy").addEventListener("click", copyJSON);
  $("clear").addEventListener("click", clearAll);
  $("healthBtn").addEventListener("click", health);
  $("genImg").addEventListener("click", generateWithImages);


  // First render
  render([], {});
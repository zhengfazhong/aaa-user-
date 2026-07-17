/**
 * User设定差分1.0 (st-user-persona-diff)
 * ------------------------------------------------
 * 为"每一个 user persona"单独保存多个平行世界差分（名字 + 正文 + 标签 + 备注），
 * 弹窗内以气泡卡片形式浏览，点开查看详情，可编辑/复制/删除，并可一键应用覆盖到当前 persona。
 *
 * 数据结构（存放在酒馆 extension_settings.st_user_persona_diff 下，按当前 persona 的
 * avatar 文件名分组，因为每个 user persona 天然对应唯一头像文件，用它做 key 保证
 * "差分只属于这一个 user"）：
 * {
 *   "<personaAvatarFile>": {
 *     variants: [
 *       { id, name, content, tags: [], note, updatedAt }
 *     ]
 *   }
 * }
 */

(function () {
  'use strict';

  const MODULE_NAME = 'st_user_persona_diff';
  const context = SillyTavern.getContext();

  // ---------- 存储：优先使用 extension_settings，兜底用 localStorage ----------

  function loadStore() {
    try {
      const settings = context.extensionSettings || {};
      if (!settings[MODULE_NAME]) settings[MODULE_NAME] = {};
      return settings[MODULE_NAME];
    } catch {
      try {
        return JSON.parse(localStorage.getItem(MODULE_NAME) || '{}');
      } catch {
        return {};
      }
    }
  }

  function saveStore(store) {
    try {
      const settings = context.extensionSettings || {};
      settings[MODULE_NAME] = store;
      if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
      } else if (typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
      }
    } catch {
      try {
        localStorage.setItem(MODULE_NAME, JSON.stringify(store));
      } catch {}
    }
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function currentPersonaKeyDebug() {
    const debug = { method: null, raw: null };

    // 方式一：优先尝试从酒馆全局状态里直接拿当前选中的 persona 头像文件名
    try {
      const candidates = [
        ['context.userAvatar', context.userAvatar],
        ['context.user_avatar', context.user_avatar],
        ['window.user_avatar', window.user_avatar],
        [
          'window.getUserAvatar()',
          typeof window.getUserAvatar === 'function' ? window.getUserAvatar() : null,
        ],
      ];
      for (const [label, c] of candidates) {
        if (c && typeof c === 'string' && c.trim()) {
          debug.method = '全局变量:' + label;
          debug.raw = c.trim();
          return { key: 'avatar:' + c.trim(), debug };
        }
      }
    } catch {}

    // 方式二：从 DOM 里找当前选中的头像（用原有的 selected 选择器精确定位，
    // 只是补全正则以支持 ?type=persona&file=xxx.png 这种参数格式）
    try {
      const $selected = $(
        [
          '#user_avatar_block .avatar-container.selected img',
          '#user_avatar_block img.selected',
          '#user_avatar_block .avatar.selected img',
          '#user_avatar_block .selected img',
          '.persona_selector.selected img',
          '#user_avatar_block [title].selected img',
        ].join(', ')
      ).first();
      const src = $selected.attr('src') || '';
      const match =
        src.match(/[?&]file=([^&]+)/i) ||
        src.match(/User%20Avatars\/([^/?]+)/i) ||
        src.match(/User Avatars\/([^/?]+)/i) ||
        src.match(/[?&]avatar=([^&]+)/i);
      if (match && match[1]) {
        debug.method = 'DOM选中头像(file参数)';
        debug.raw = src;
        return { key: 'avatar:' + decodeURIComponent(match[1]), debug };
      }
      debug.raw = 'DOM匹配到元素但正则未解析出file，src=' + (src || '(未找到selected元素)');
    } catch (e) {
      debug.raw = 'DOM读取报错:' + (e && e.message);
    }

    // 方式三：兜底用当前 persona 名字输入框的值
    const name = ($('#persona_name').val() || '').toString().trim();
    debug.method = '兜底:persona_name输入框';
    debug.raw = (debug.raw ? debug.raw + ' | ' : '') + 'persona_name=' + (name || '(空)');
    return { key: name ? 'name:' + name : 'default', debug };
  }

  function currentPersonaKey() {
    return currentPersonaKeyDebug().key;
  }

  function getVariantsFor(key) {
    const store = loadStore();
    if (!store[key]) store[key] = { variants: [] };
    return store[key].variants;
  }

  function withVariantsFor(key, mutator) {
    const store = loadStore();
    if (!store[key]) store[key] = { variants: [] };
    mutator(store[key].variants);
    saveStore(store);
  }

  function escapeHtml(str) {
    return (str || '')
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 把纯文本按换行分段，转成多个 <p>，让长文能看出分段
  function textToParagraphs(text) {
    const parts = (text || '').split(/\n{1,}/);
    return parts.map((p) => `<p class="upd-para">${escapeHtml(p) || '&nbsp;'}</p>`).join('');
  }

  // ---------- 导出/导入备份 ----------

  const BACKUP_FORMAT = 'st-user-persona-diff-backup';

  // 给一个分组取展示用的标签：优先用组内第一条差分的名字，没有就用 key 兜底
  function personaLabelFor(key, variants) {
    const firstNamed = (variants || []).find((v) => v.name && v.name.trim());
    if (firstNamed) return firstNamed.name.trim();
    return key;
  }

  function buildBackupPayload(keys) {
    const store = loadStore();
    const groups = {};
    keys.forEach((key) => {
      const variants = (store[key] && store[key].variants) || [];
      groups[key] = {
        personaLabel: personaLabelFor(key, variants),
        variants: variants,
      };
    });
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      groups,
    };
  }

  function downloadJson(filename, dataObj) {
    const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const $a = $('<a></a>').attr({ href: url, download: filename }).appendTo('body');
    $a[0].click();
    $a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function exportCurrent(key) {
    const variants = getVariantsFor(key);
    if (!variants.length) {
      toastr.warning('当前 user 还没有任何差分，无需导出');
      return;
    }
    const payload = buildBackupPayload([key]);
    const label = payload.groups[key].personaLabel;
    downloadJson(`user差分备份-${label}-${Date.now()}.json`, payload);
    toastr.success('已导出当前 user 的备份');
  }

  function exportAll() {
    const store = loadStore();
    const keys = Object.keys(store).filter((k) => (store[k].variants || []).length > 0);
    if (!keys.length) {
      toastr.warning('还没有任何差分数据，无需导出');
      return;
    }
    const payload = buildBackupPayload(keys);
    downloadJson(`user差分备份-全部-${Date.now()}.json`, payload);
    toastr.success('已导出全部 user 的备份');
  }

  // 解析导入文件内容，做基本校验，返回 { ok, groups, error }
  function parseBackupFile(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: '文件不是合法的 JSON 格式' };
    }
    if (!data || data.format !== BACKUP_FORMAT || !data.groups || typeof data.groups !== 'object') {
      return { ok: false, error: '文件内容不是本插件的备份格式' };
    }
    return { ok: true, groups: data.groups };
  }

  // 实际执行导入：勾选的分组、勾选的差分，全部以新 id 追加进对应 key 下（共存，不覆盖不去重）
  function performImport(groups, selection) {
    const store = loadStore();
    let importedCount = 0;
    Object.keys(groups).forEach((key) => {
      const group = groups[key];
      const selectedIds = selection[key];
      if (!selectedIds || !selectedIds.size) return;
      if (!store[key]) store[key] = { variants: [] };
      (group.variants || []).forEach((v) => {
        if (!selectedIds.has(v.id)) return;
        store[key].variants.push({
          id: uuid(), // 重新生成 id，避免和现有数据冲突
          name: v.name || '',
          content: v.content || '',
          tags: Array.isArray(v.tags) ? v.tags : [],
          note: v.note || '',
          updatedAt: Date.now(),
        });
        importedCount++;
      });
    });
    saveStore(store);
    return importedCount;
  }

  // ---------- 应用差分：覆盖当前 persona 名字 + 正文 ----------

  function applyVariant(variant) {
    const $name = $('#persona_name');
    $name.val(variant.name || '');
    $name.trigger('input').trigger('change');

    const $desc = $('#persona_description');
    $desc.val(variant.content || '');
    $desc.trigger('input').trigger('change');

    toastr.success(`已应用差分：${variant.name || '未命名'}`);
  }

  // ---------- 弹窗状态 ----------

  let popupState = {
    selectedId: null, // null = 列表页
    editing: false,
  };

  // ---------- 弹窗 UI ----------

  function buildPopupHtml() {
    return `
      <div class="upd-wrap">
        <h3 class="upd-title">
          ✙ 人设差分 ✙
        </h3>
        <div class="upd-backup-toggle" id="upd_backup_toggle">
          <span class="fa-solid fa-box-archive"></span> 导出/导入备份
          <span class="fa-solid fa-chevron-down upd-backup-chevron"></span>
        </div>
        <div class="upd-backup-panel" id="upd_backup_panel" style="display:none;">
          <div class="upd-bottom-actions">
            <div class="menu_button" id="upd_export_current"><span class="fa-solid fa-file-export"></span> 导出当前user备份</div>
            <div class="menu_button" id="upd_export_all"><span class="fa-solid fa-file-export"></span> 导出全部备份</div>
          </div>
          <div class="upd-bottom-actions">
            <div class="menu_button" id="upd_import_open"><span class="fa-solid fa-file-import"></span> 导入备份（可勾选）</div>
          </div>
          <input type="file" id="upd_import_file_input" accept="application/json,.json" style="display:none;" />
        </div>
        <div id="upd_body"></div>
      </div>
    `;
  }

  function render($root, key) {
    const $body = $root.find('#upd_body');
    $body.empty();

    if (popupState.selectedId === null) {
      renderListPage($body, key);
    } else if (popupState.editing) {
      renderEditPage($body, key);
    } else {
      renderDetailPage($body, key);
    }
  }

  // ----- 列表页 -----

  function renderListPage($body, key) {
    const variants = getVariantsFor(key);

    const $list = $('<div class="upd-bubble-list"></div>');
    if (!variants.length) {
      $list.append('<div class="upd-empty-list">暂无差分，点击下方"新增差分"创建第一个平行世界～</div>');
    } else {
      variants.forEach((v) => {
        const $bubble = $(`
          <div class="upd-bubble">
            <div class="upd-bubble-name">${escapeHtml(v.name || '未命名差分')}</div>
            ${v.note ? `<div class="upd-bubble-note">${escapeHtml(v.note)}</div>` : ''}
            <div class="upd-bubble-tags">
              ${(v.tags || []).map((t) => `<span class="upd-bubble-tag">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
        `);
        $bubble.on('click', () => {
          popupState.selectedId = v.id;
          popupState.editing = false;
          render($body.closest('.upd-wrap'), key);
        });
        $list.append($bubble);
      });
    }
    $body.append($list);

    const $actions = $(`
      <div class="upd-bottom-actions">
        <div class="menu_button" id="upd_new"><span class="fa-solid fa-plus"></span> 新增差分</div>
      </div>
    `);
    $actions.find('#upd_new').on('click', () => {
      const draft = { id: uuid(), name: '', content: '', tags: [], note: '', updatedAt: Date.now() };
      withVariantsFor(key, (list) => list.push(draft));
      popupState.selectedId = draft.id;
      popupState.editing = true;
      render($body.closest('.upd-wrap'), key);
    });
    $body.append($actions);
  }

  // ----- 详情页（只读） -----

  function renderDetailPage($body, key) {
    const variants = getVariantsFor(key);
    const v = variants.find((x) => x.id === popupState.selectedId);
    if (!v) {
      popupState.selectedId = null;
      renderListPage($body, key);
      return;
    }

    const $html = $(`
      <div class="upd-detail-card">
        <div class="upd-detail-name">${escapeHtml(v.name || '未命名差分')}</div>
        <div class="upd-detail-tags">
          ${
            (v.tags || []).map((t) => `<span class="upd-detail-tag">${escapeHtml(t)}</span>`).join('') ||
            '<span style="opacity:0.45;font-size:0.82em;">无标签</span>'
          }
        </div>
        ${v.note ? `<div class="upd-detail-note">${escapeHtml(v.note)}</div>` : ''}
        <div class="upd-content-box">${
          textToParagraphs(v.content) || '<p class="upd-para" style="opacity:0.5;">(空)</p>'
        }</div>
        <div class="upd-bottom-actions">
          <div class="menu_button" id="upd_apply"><span class="fa-solid fa-check"></span> 应用</div>
          <div class="menu_button" id="upd_edit"><span class="fa-solid fa-pen-to-square"></span> 编辑</div>
          <div class="menu_button" id="upd_dup"><span class="fa-solid fa-copy"></span> 复制</div>
          <div class="menu_button" id="upd_del"><span class="fa-solid fa-trash"></span> 删除</div>
        </div>
        <div class="upd-bottom-actions">
          <div class="menu_button" id="upd_back_list"><span class="fa-solid fa-arrow-left"></span> 返回列表</div>
        </div>
      </div>
    `);

    $html.find('#upd_back_list').on('click', () => {
      popupState.selectedId = null;
      render($body.closest('.upd-wrap'), key);
    });

    $html.find('#upd_apply').on('click', () => applyVariant(v));

    $html.find('#upd_edit').on('click', () => {
      popupState.editing = true;
      render($body.closest('.upd-wrap'), key);
    });

    $html.find('#upd_dup').on('click', () => {
      const copy = {
        ...v,
        id: uuid(),
        name: (v.name || '未命名差分') + ' 副本',
        tags: [...(v.tags || [])],
        updatedAt: Date.now(),
      };
      withVariantsFor(key, (list) => list.push(copy));
      popupState.selectedId = copy.id;
      render($body.closest('.upd-wrap'), key);
      toastr.success('已复制差分');
    });

    $html.find('#upd_del').on('click', () => {
      if (!confirm(`确定要删除差分「${v.name || '未命名差分'}」吗？此操作无法撤销。`)) return;
      withVariantsFor(key, (list) => {
        const idx = list.findIndex((x) => x.id === v.id);
        if (idx >= 0) list.splice(idx, 1);
      });
      popupState.selectedId = null;
      render($body.closest('.upd-wrap'), key);
      toastr.success('已删除差分');
    });

    $body.append($html);
  }

  // ----- 编辑页 -----

  function renderEditPage($body, key) {
    const variants = getVariantsFor(key);
    const v = variants.find((x) => x.id === popupState.selectedId);
    if (!v) {
      popupState.selectedId = null;
      popupState.editing = false;
      renderListPage($body, key);
      return;
    }

    const workingTags = [...(v.tags || [])];

    function cancelAndBack() {
      popupState.editing = false;
      if (!v.name && !v.content && (v.tags || []).length === 0 && !v.note) {
        withVariantsFor(key, (list) => {
          const idx = list.findIndex((x) => x.id === v.id);
          if (idx >= 0) list.splice(idx, 1);
        });
        popupState.selectedId = null;
      }
      render($body.closest('.upd-wrap'), key);
    }

    const $form = $(`
      <div class="upd-form">
        <div class="upd-field">
          <label class="upd-field-label">名字</label>
          <input class="text_pole upd-name-input" id="upd_f_name" placeholder="请填写user名字" value="${escapeHtml(v.name)}" />
        </div>
        <div class="upd-field">
          <label class="upd-field-label">标签</label>
          <div class="upd-tag-editor" id="upd_tag_editor"></div>
        </div>
        <div class="upd-field">
          <label class="upd-field-label">备注</label>
          <input class="text_pole" id="upd_f_note" placeholder="可输入备注" value="${escapeHtml(v.note)}" />
        </div>
        <div class="upd-field">
          <label class="upd-field-label">具体设定内容</label>
          <textarea class="text_pole" id="upd_f_content" rows="12">${escapeHtml(v.content)}</textarea>
        </div>
        <div class="upd-bottom-actions">
          <div class="menu_button" id="upd_f_fill_current"><span class="fa-solid fa-arrow-down-to-bracket"></span> 填入当前设定</div>
          <div class="menu_button" id="upd_f_apply"><span class="fa-solid fa-check-double"></span> 保存并应用</div>
          <div class="menu_button" id="upd_f_save"><span class="fa-solid fa-floppy-disk"></span> 确定</div>
        </div>
        <div class="upd-bottom-actions">
          <div class="menu_button" id="upd_f_cancel"><span class="fa-solid fa-arrow-left"></span> 取消并返回</div>
        </div>
      </div>
    `);

    function renderTagEditor() {
      const $editor = $form.find('#upd_tag_editor');
      $editor.empty();
      workingTags.forEach((tag, idx) => {
        const $chip = $(`
          <span class="upd-tag-chip-removable">
            ${escapeHtml(tag)}
            <span class="fa-solid fa-xmark" data-idx="${idx}"></span>
          </span>
        `);
        $chip.find('.fa-xmark').on('click', () => {
          workingTags.splice(idx, 1);
          renderTagEditor();
        });
        $editor.append($chip);
      });
      const $addInput = $('<input type="text" class="upd-tag-add-input" placeholder="+ 新标签，回车添加" />');
      $addInput.on('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = $addInput.val().toString().trim();
          if (val && !workingTags.includes(val)) {
            workingTags.push(val);
            renderTagEditor();
          } else {
            $addInput.val('');
          }
        }
      });
      $addInput.on('blur', () => {
        const val = $addInput.val().toString().trim();
        if (val && !workingTags.includes(val)) {
          workingTags.push(val);
          renderTagEditor();
        }
      });
      $editor.append($addInput);
    }
    renderTagEditor();

    function collectAndSave() {
      const name = ($form.find('#upd_f_name').val() || '').toString().trim();
      const note = ($form.find('#upd_f_note').val() || '').toString().trim();
      const content = ($form.find('#upd_f_content').val() || '').toString();

      const saved = { id: v.id, name, content, tags: [...workingTags], note, updatedAt: Date.now() };
      withVariantsFor(key, (list) => {
        const idx = list.findIndex((x) => x.id === saved.id);
        if (idx >= 0) list[idx] = saved;
        else list.push(saved);
      });
      return saved;
    }

    $form.find('#upd_f_save').on('click', () => {
      collectAndSave();
      popupState.editing = false;
      render($body.closest('.upd-wrap'), key);
      toastr.success('已保存差分');
    });

    $form.find('#upd_f_apply').on('click', () => {
      const saved = collectAndSave();
      applyVariant(saved);
      popupState.editing = false;
      render($body.closest('.upd-wrap'), key);
    });

    $form.find('#upd_f_cancel').on('click', () => {
      cancelAndBack();
    });

    $form.find('#upd_f_fill_current').on('click', () => {
      const currentName = ($('#persona_name').val() || '').toString();
      const currentDesc = ($('#persona_description').val() || '').toString();
      $form.find('#upd_f_name').val(currentName);
      $form.find('#upd_f_content').val(currentDesc);
      toastr.success('已填入当前 user 设定');
    });

    $body.append($form);
  }

  // ---------- 打开弹窗 ----------

  // ---------- 导出/导入备份面板的交互绑定 ----------

  function bindBackupPanel($el, key) {
    const $toggle = $el.find('#upd_backup_toggle');
    const $panel = $el.find('#upd_backup_panel');
    const $chevron = $el.find('.upd-backup-chevron');

    $toggle.on('click', () => {
      const isOpen = $panel.is(':visible');
      $panel.slideToggle(150);
      $chevron.toggleClass('upd-backup-chevron-open', !isOpen);
    });

    $el.find('#upd_export_current').on('click', () => exportCurrent(key));
    $el.find('#upd_export_all').on('click', () => exportAll());

    const $fileInput = $el.find('#upd_import_file_input');
    $el.find('#upd_import_open').on('click', () => {
      $fileInput.val('');
      $fileInput.trigger('click');
    });

    $fileInput.on('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseBackupFile(String(reader.result || ''));
        if (!result.ok) {
          toastr.error(result.error || '导入失败：文件格式不正确');
          return;
        }
        showImportPreview($el, key, result.groups);
      };
      reader.onerror = () => toastr.error('文件读取失败');
      reader.readAsText(file);
    });
  }

  // 显示导入预览弹窗：按分组展示，可勾选每条差分，支持全选/全不选
  function showImportPreview($el, key, groups) {
    const groupKeys = Object.keys(groups).filter((k) => (groups[k].variants || []).length > 0);
    if (!groupKeys.length) {
      toastr.warning('这份备份文件里没有可导入的差分');
      return;
    }

    const $overlay = $(`
      <div class="upd-import-overlay">
        <div class="upd-import-modal">
          <div class="upd-import-title">导入预览 — 请勾选要导入的差分</div>
          <div class="upd-import-hint">相同人设默认共存，不会覆盖或去重已有的差分</div>
          <div class="upd-import-groups"></div>
          <div class="upd-bottom-actions">
            <div class="menu_button" id="upd_import_select_all">全选</div>
            <div class="menu_button" id="upd_import_select_none">全不选</div>
          </div>
          <div class="upd-bottom-actions">
            <div class="menu_button" id="upd_import_confirm"><span class="fa-solid fa-check"></span> 确认导入</div>
            <div class="menu_button" id="upd_import_cancel"><span class="fa-solid fa-xmark"></span> 取消导入</div>
          </div>
        </div>
      </div>
    `);

    const $groupsWrap = $overlay.find('.upd-import-groups');
    groupKeys.forEach((gKey) => {
      const group = groups[gKey];
      const $group = $(`
        <div class="upd-import-group">
          <div class="upd-import-group-title">
            <label>
              <input type="checkbox" class="upd-import-group-check" checked />
              ${escapeHtml(group.personaLabel || gKey)}
            </label>
          </div>
          <div class="upd-import-group-items"></div>
        </div>
      `);
      const $items = $group.find('.upd-import-group-items');
      (group.variants || []).forEach((v) => {
        const $item = $(`
          <label class="upd-import-item">
            <input type="checkbox" class="upd-import-item-check" data-group="${escapeHtml(gKey)}" data-id="${escapeHtml(v.id)}" checked />
            <span class="upd-import-item-name">${escapeHtml(v.name || '未命名差分')}</span>
            ${v.note ? `<span class="upd-import-item-note">${escapeHtml(v.note)}</span>` : ''}
          </label>
        `);
        $items.append($item);
      });
      // 分组勾选框联动组内所有条目
      $group.find('.upd-import-group-check').on('change', function () {
        const checked = $(this).is(':checked');
        $items.find('.upd-import-item-check').prop('checked', checked);
      });
      $groupsWrap.append($group);
    });

    $overlay.find('#upd_import_select_all').on('click', () => {
      $overlay.find('.upd-import-item-check, .upd-import-group-check').prop('checked', true);
    });
    $overlay.find('#upd_import_select_none').on('click', () => {
      $overlay.find('.upd-import-item-check, .upd-import-group-check').prop('checked', false);
    });

    $overlay.find('#upd_import_cancel').on('click', () => $overlay.remove());

    $overlay.find('#upd_import_confirm').on('click', () => {
      const selection = {};
      $overlay.find('.upd-import-item-check:checked').each(function () {
        const gKey = $(this).attr('data-group');
        const id = $(this).attr('data-id');
        if (!selection[gKey]) selection[gKey] = new Set();
        selection[gKey].add(String(id));
      });
      const total = Object.values(selection).reduce((sum, s) => sum + s.size, 0);
      if (!total) {
        toastr.warning('请至少勾选一条差分再确认导入');
        return;
      }
      const importedCount = performImport(groups, selection);
      toastr.success(`已导入 ${importedCount} 条差分`);
      $overlay.remove();
      render($el, key);
    });

    $('body').append($overlay);
  }

  async function openPopup() {
    const key = currentPersonaKey();
    popupState = { selectedId: null, editing: false };

    const $el = $(buildPopupHtml());
    bindBackupPanel($el, key);
    render($el, key);

    await context.callGenericPopup($el[0], context.POPUP_TYPE.TEXT, undefined, {
      wide: true,
      wider: true,
      okButton: '关闭',
      allowVerticalScrolling: true,
    });
  }

  // ---------- 入口按钮：放在"使用者描述"上方 ----------

  function injectEntryButton() {
    if ($('#upd_entry_btn').length) return;

    const $descField = $('#persona_description');
    if (!$descField.length) return;

    const $fieldContainer = $descField.closest('.flex-container, div').first();

    const $btn = $(`
      <div id="upd_entry_btn" class="menu_button menu_button_icon">
        <span>✙人设差分✙</span>
      </div>
    `);
    $btn.on('click', openPopup);

    if ($fieldContainer.length) {
      $fieldContainer.before($btn);
    } else {
      $descField.before($btn);
    }
  }

  // ---------- 初始化 ----------

  jQuery(async () => {
    injectEntryButton();
    const observer = new MutationObserver(() => injectEntryButton());
    const target = document.querySelector('#user_settings_block') || document.body;
    observer.observe(target, { childList: true, subtree: true });
    console.info('[st-user-persona-diff] Initialized');
  });
})();

from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=root/'app.js'
s=p.read_text(encoding='utf-8')
assert '<aside class="sidebar">' in s, 'v2 migration already applied'
a=s.index('  function nav() {');b=s.index('  function field(',a)
s=s[:a]+(root/'tools/app-views.fragment.js').read_text(encoding='utf-8')+s[b:]
s=s.replace("filter: 'all' };", "filter: 'all', sheetStack: [] };")
s=s.replace("var f=ui.form, d=f.data||{}, body='', title='', sub='', submit='保存', marker='leaf';", "var f=ui.form, d=f.data||{}, body='', title='', sub='', submit='保存', marker='leaf';\n    if(['schedule','events','point-list','reward-list','archive','preferences'].indexOf(f.kind)>=0)return menuSheet(f.kind);")
for old,new in [('改一改这个安排','改一改安排'),('把一件小事，放在这里。','记一件小事'),('这份努力，值得被看见。','记一个闪光'),('一起兑现这个小心愿。','兑现小心愿'),('添加一个值得鼓励的行为','添加加分项'),('调成适合我们家的样子。','我们家的设置'),('说出来，脑袋轻松一点。','说出来，轻松一点')]:s=s.replace(old,new)
a=s.index('    return \'<section class="form-layout"');b=s.index('  function focusPage()',a)
s=s[:a]+'''    return '<div class="sheet-overlay"><div class="sheet-backdrop" data-action="form-close"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-grip" aria-hidden="true"></div><header class="sheet-header"><div><h2 id="sheet-title">'+title+'</h2><p class="form-sub">'+sub+'</p></div>'+button('form-close',icon(ui.sheetStack.length?'back':'close'),'icon-button').replace('<button ','<button aria-label="'+(ui.sheetStack.length?'返回上层面板':'关闭面板')+'" ')+'</header><form id="editor-form" class="sheet-form" novalidate><div class="sheet-body">'+body+'<p id="form-error" class="form-error" role="alert" tabindex="-1" hidden></p>'+(f.kind==='task'&&d.id?'<div class="delete-area">'+button('task-delete','移除这个安排','text-button danger',d.id)+'<small>仍可在收好的安排中恢复</small></div>':'')+'</div><div class="sheet-footer"><button type="submit" class="btn primary full" data-label="'+submit+'" '+(f.kind==='redeem'&&!d.allowed?'disabled':'')+'>'+submit+icon('check')+'</button></div></form></section></div>';
  }
''' +s[b:]
a=s.index('  function render(scroll) {');b=s.index('  function clearDraft()',a)
s=s[:a]+'''  function render(scroll) {
    var app=document.getElementById('app'),oldMain=document.getElementById('main'),scrollTop=oldMain?oldMain.scrollTop:0;
    document.body.className='view-'+ui.view+' '+(ui.quiet?'quiet ':'')+(ui.display?'display-mode ':'')+(ui.focusId?'focusing ':'')+(ui.form?'sheet-open ':'');
    var content=ui.focusId?focusPage():({home:home,rewards:rewards,memories:memories,parent:parent}[ui.view]||home)();
    app.innerHTML='<div class="app-shell" '+(ui.form?'aria-hidden="true"':'')+'>'+header()+'<main id="main" class="app-main '+(ui.view==='home'?'home-main':'')+'" tabindex="-1">'+content+'</main><nav class="bottom-nav" aria-label="应用导航">'+nav()+'</nav></div>'+(ui.form?formPage():'');
    var main=document.getElementById('main');if(main)main.scrollTop=scroll&&!ui.form?0:scrollTop;
  }
  function openForm(kind,data,resume) {
    stopRecognition();
    if(ui.form && ['schedule','events','point-list','reward-list','archive','preferences'].indexOf(ui.form.kind)>=0 && ui.form.kind!==kind)ui.sheetStack.push(ui.form);
    var draft=readStore('little-steps-draft',null);
    if(resume&&draft&&draft.kind===kind&&!draft.data.id){data=draft.data;if(kind==='task'&&data.date<today())data.date=today();toast('上次的草稿还在，可以接着写。');}
    ui.form={kind:kind,data:data||{},openedRevision:revision};ui.focusId=null;render(false);
    setTimeout(function(){var target=document.querySelector(window.innerWidth>900?'.sheet input:not([type="hidden"])':'.sheet-header button')||document.querySelector('.sheet-header button');if(target)target.focus();},70);
  }
  function closeSheet() {stopRecognition();ui.form=ui.sheetStack.pop()||null;render(false);}
''' +s[b:]
s=s.replace("if(action==='nav'){stopRecognition();ui.view=id;ui.form=null;ui.focusId=null;render(true);}","if(action==='nav'){stopRecognition();ui.view=id;ui.form=null;ui.sheetStack=[];ui.focusId=null;render(true);}\n    else if(['schedule','events','point-list','reward-list','archive','preferences'].indexOf(action)>=0)openForm(action,{});")
s=s.replace("else if(action==='form-close'){stopRecognition();ui.form=null;render(true);}","else if(action==='form-close')closeSheet();")
s=s.replace("var k=f.kind;clearDraft();ui.form=null;", "var k=f.kind;clearDraft();ui.form=ui.sheetStack.pop()||null;")
s=s.replace("ui.form=null;toast('已收起这个安排", "ui.form=ui.sheetStack.pop()||null;toast('已收起这个安排")
s=s.replace("ui.view='home';ui.form=null;ui.focusId=null;ui.day=0;", "ui.view='home';ui.form=null;ui.sheetStack=[];ui.focusId=null;ui.day=0;")
s=s.replace("if(input)input.value=text;", "if(input){input.value=text;rememberDraft();}")
s=s.replace("'childName','text',state.childName,", "'childName','text',d.childName===undefined?state.childName:d.childName,")
s=s.replace("}),state.settings.preferredReward)", "}),d.preferredReward===undefined?state.settings.preferredReward:d.preferredReward)")
s=s.replace("']],state.settings.monthEndDays)", "']],d.monthEndDays===undefined?state.settings.monthEndDays:d.monthEndDays)")
a=s.index("  document.addEventListener('keydown'");b=s.index("  window.addEventListener('storage'",a)
s=s[:a]+'''  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){if(ui.form)closeSheet();else if(ui.focusId){ui.focusId=null;render(true);}}
    if(e.key==='Tab'&&ui.form){var sheet=document.querySelector('.sheet'),nodes=sheet?sheet.querySelectorAll('button:not([disabled]),input:not([type="hidden"]),select,textarea,[tabindex="0"]'):[];if(nodes.length){var first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
  });
  var touchOrigin=null;
  document.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;var el=e.target;touchOrigin={x:e.touches[0].clientX,y:e.touches[0].clientY,grip:el.classList&&el.classList.contains('sheet-grip')};},{passive:true});
  document.addEventListener('touchend',function(e){if(!touchOrigin||!e.changedTouches.length)return;var dx=e.changedTouches[0].clientX-touchOrigin.x,dy=e.changedTouches[0].clientY-touchOrigin.y;if(touchOrigin.grip&&dy>65&&Math.abs(dx)<70)closeSheet();touchOrigin=null;},{passive:true});
  function fitViewport(){var root=document.documentElement;if(root.style&&root.style.setProperty)root.style.setProperty('--app-height',((window.visualViewport&&window.visualViewport.height)||window.innerHeight)+'px');}
  fitViewport();window.addEventListener('resize',fitViewport);if(window.visualViewport)window.visualViewport.addEventListener('resize',fitViewport);
''' +s[b:]
p.write_text(s,encoding='utf-8')
print('App v2 views, app shell and sheet interactions applied.')

// 分组管理模块

// 全局变量
let groups = [{ id: 0, name: '分组1', musicList: [] }];
let currentGroup = 0;

// 初始化分组列表
function initGroupList() {
  const groupList = document.getElementById('groupList');
  if (!groupList) return;
  
  groupList.innerHTML = '';
  
  groups.forEach((group, index) => {
    const groupItem = document.createElement('li');
    groupItem.className = `group-item ${index === currentGroup ? 'active' : ''}`;
    groupItem.dataset.group = index;
    
    groupItem.innerHTML = `
      <div class="group-name-container">
        <span class="group-name">${group.name}</span>
      </div>
      <span class="status-indicator ${group.playingIndex !== -1 ? 'playing' : ''}"></span>
    `;
    
    // 添加点击事件
    groupItem.addEventListener('click', function() {
      const groupIndex = parseInt(this.dataset.group);
      switchGroup(groupIndex);
    });
    
    // 添加右键菜单事件
    groupItem.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      const groupIndex = parseInt(this.dataset.group);
      showGroupContextMenu(e, groupIndex);
    });
    
    groupList.appendChild(groupItem);
  });
}

// 切换分组
function switchGroup(index) {
  if (index < 0 || index >= groups.length) return;
  
  currentGroup = index;
  
  // 更新分组列表的激活状态
  const groupItems = document.querySelectorAll('.group-item');
  groupItems.forEach((item, i) => {
    item.classList.toggle('active', i === currentGroup);
  });
  
  // 初始化音乐网格
  if (window.initMusicGrid) {
    window.initMusicGrid();
  }
  
  // 如果分组保留播放关闭，停止当前音乐
  if (!window.groupPlaybackEnabled && window.musicModule) {
    window.musicModule.stop();
  } else if (window.groupPlaybackEnabled && window.musicModule) {
    // 如果分组保留播放开启，恢复分组的播放状态
    const group = groups[currentGroup];
    if (group.playingIndex !== -1) {
      window.musicModule.play(group.playingIndex);
    }
  }
}

// 添加分组
function addGroup(groupName) {
  if (!groupName) {
    if (window.utils) {
      window.utils.showAlert('请输入分组名称');
    } else {
      alert('请输入分组名称');
    }
    return;
  }
  
  const newGroupId = groups.length;
  groups.push({ id: newGroupId, name: groupName, musicList: [], playingIndex: -1 });
  
  // 初始化分组列表
  initGroupList();
  
  // 切换到新分组
  switchGroup(newGroupId);
}

// 重命名分组
function renameGroup(index, newName) {
  if (!newName) {
    if (window.utils) {
      window.utils.showAlert('请输入分组名称');
    } else {
      alert('请输入分组名称');
    }
    return;
  }
  
  if (index >= 0 && index < groups.length) {
    groups[index].name = newName;
    initGroupList();
  }
}

// 复制分组
function copyGroup(index) {
  if (index >= 0 && index < groups.length) {
    const originalGroup = groups[index];
    const newGroupId = groups.length;
    const newGroupName = `${originalGroup.name} (复制)`;
    
    // 深度克隆分组
    let newMusicList = [];
    if (originalGroup.musicList) {
      newMusicList = originalGroup.musicList.map(music => {
        return { ...music };
      });
    }
    
    groups.push({ 
      id: newGroupId, 
      name: newGroupName, 
      musicList: newMusicList,
      playingIndex: -1 
    });
    
    // 初始化分组列表
    initGroupList();
  }
}

// 删除分组
function deleteGroup(index) {
  if (index >= 0 && index < groups.length) {
    // 不能删除最后一个分组
    if (groups.length <= 1) {
      if (window.utils) {
        window.utils.showAlert('至少需要保留一个分组');
      } else {
        alert('至少需要保留一个分组');
      }
      return;
    }
    
    // 如果删除的是当前分组，切换到其他分组
    if (index === currentGroup) {
      switchGroup(0);
    }
    
    // 从UDP设置中删除对应的分组设置
    if (window.udpSettings) {
      delete window.udpSettings[index];
      // 更新后续分组的UDP设置索引
      for (let i = index + 1; i < groups.length; i++) {
        if (window.udpSettings[i]) {
          window.udpSettings[i - 1] = window.udpSettings[i];
          delete window.udpSettings[i];
        }
      }
    }
    
    // 删除分组
    groups.splice(index, 1);
    
    // 更新分组ID
    groups.forEach((group, i) => {
      group.id = i;
    });
    
    // 初始化分组列表
    initGroupList();
  }
}

// 显示分组右键菜单
function showGroupContextMenu(e, groupIndex) {
  const contextMenu = document.getElementById('groupContextMenu');
  if (!contextMenu) return;
  
  // 设置菜单位置
  contextMenu.style.left = e.clientX + 'px';
  contextMenu.style.top = e.clientY + 'px';
  contextMenu.style.display = 'block';
  
  // 绑定菜单项事件
  const renameGroupBtn = document.getElementById('renameGroup');
  const copyGroupBtn = document.getElementById('copyGroup');
  const deleteGroupBtn = document.getElementById('deleteGroup');
  
  if (renameGroupBtn) {
    renameGroupBtn.onclick = function() {
      const newName = prompt('请输入新的分组名称:', groups[groupIndex].name);
      if (newName !== null) {
        renameGroup(groupIndex, newName);
      }
      contextMenu.style.display = 'none';
    };
  }
  
  if (copyGroupBtn) {
    copyGroupBtn.onclick = function() {
      copyGroup(groupIndex);
      contextMenu.style.display = 'none';
    };
  }
  
  if (deleteGroupBtn) {
    deleteGroupBtn.onclick = function() {
      if (confirm('确定要删除这个分组吗？')) {
        deleteGroup(groupIndex);
      }
      contextMenu.style.display = 'none';
    };
  }
  
  // 点击其他地方关闭菜单
  document.addEventListener('click', function closeMenu() {
    contextMenu.style.display = 'none';
    document.removeEventListener('click', closeMenu);
  });
}

// 更新分组状态指示器
function updateGroupStatusIndicators() {
  const groupItems = document.querySelectorAll('.group-item');
  groupItems.forEach((item, index) => {
    const statusIndicator = item.querySelector('.status-indicator');
    if (statusIndicator) {
      if (groups[index].playingIndex !== -1) {
        statusIndicator.classList.add('playing');
      } else {
        statusIndicator.classList.remove('playing');
      }
    }
  });
}

// 初始化分组模块
function initGroupModule() {
  // 初始化分组列表
  initGroupList();
  
  // 绑定添加分组按钮
  const addGroupBtn = document.getElementById('addGroupBtn');
  if (addGroupBtn) {
    addGroupBtn.addEventListener('click', function() {
      const addModal = document.getElementById('addModal');
      const addModalOverlay = document.getElementById('addModalOverlay');
      const groupNameInput = document.getElementById('groupNameInput');
      const confirmAddGroup = document.getElementById('confirmAddGroup');
      const cancelAddGroup = document.getElementById('cancelAddGroup');
      
      if (addModal && addModalOverlay) {
        // 重置输入框
        if (groupNameInput) {
          groupNameInput.value = '';
        }
        
        // 显示模态框
        addModal.style.display = 'block';
        addModalOverlay.style.display = 'block';
        
        // 绑定确认按钮
        if (confirmAddGroup) {
          confirmAddGroup.onclick = function() {
            if (groupNameInput) {
              addGroup(groupNameInput.value);
            }
            addModal.style.display = 'none';
            addModalOverlay.style.display = 'none';
          };
        }
        
        // 绑定取消按钮
        if (cancelAddGroup) {
          cancelAddGroup.onclick = function() {
            addModal.style.display = 'none';
            addModalOverlay.style.display = 'none';
          };
        }
        
        // 点击遮罩层关闭
        addModalOverlay.addEventListener('click', function() {
          addModal.style.display = 'none';
          addModalOverlay.style.display = 'none';
        });
      }
    });
  }
  
  // 绑定文件菜单事件
  const fileMenuBtn = document.getElementById('fileMenuBtn');
  const fileMenuDropdown = document.getElementById('fileMenuDropdown');
  if (fileMenuBtn && fileMenuDropdown) {
    fileMenuBtn.addEventListener('click', function() {
      fileMenuDropdown.style.display = fileMenuDropdown.style.display === 'block' ? 'none' : 'block';
    });
    
    // 点击其他地方关闭菜单
    document.addEventListener('click', function(e) {
      if (!fileMenuBtn.contains(e.target) && !fileMenuDropdown.contains(e.target)) {
        fileMenuDropdown.style.display = 'none';
      }
    });
  }
}

// 导出分组模块
window.groupModule = {
  init: initGroupModule,
  add: addGroup,
  rename: renameGroup,
  copy: copyGroup,
  delete: deleteGroup,
  switch: switchGroup,
  getGroups: () => groups,
  setGroups: (newGroups) => groups = newGroups,
  getCurrentGroup: () => currentGroup,
  setCurrentGroup: (index) => currentGroup = index,
  updateStatusIndicators: updateGroupStatusIndicators
};